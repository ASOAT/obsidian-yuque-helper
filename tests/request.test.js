'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createRequestBridge}=require('../request');
const {YuqueClient}=require('../yuque');

test('renderer wrapper compiles trusted request source and keeps native events in main',async()=>{
  const session={};let requestOptions,compiled=false,endedArgs;
  const net={request:options=>{
    requestOptions=options;
    const request=new EventEmitter();request.abort=()=>{};
    request.end=function(){
      endedArgs=arguments.length;
      const response=new EventEmitter();response.statusCode=200;
      const originalOn=response.on;
      response.on=function(name,callback){
        originalOn.call(this,name,callback);
        if(name==='data'){
          this.emit('data',Buffer.from('{"data":{"id":42,"login":"test-user"}}'));
          this.emit('end');this.emit('close');
        }
        return this;
      };
      request.emit('response',response);
    };
    return request;
  }};
  const remote={net,require:name=>{
    assert.equal(name,'vm');
    return {runInThisContext:(source,options)=>{
      compiled=true;assert.equal(options.filename,'notebox-yuque-request-main.js');
      return vm.runInThisContext(source,options);
    }};
  }};
  const bridge=createRequestBridge({remote,session});
  const client=new YuqueClient({session,bridge});
  const me=await client.initialize('test-user');
  assert.equal(me.id,42);assert.equal(compiled,true);assert.equal(endedArgs,0);
  assert.equal(requestOptions.session,session);assert.equal(requestOptions.useSessionCookies,true);
  bridge.close();await assert.rejects(client.initialize('test-user'),{code:'CLOSED'});
});

test('bridge initialization hides raw remote failures',()=>{
  const remote={net:{request:()=>{}},require:()=>{throw new Error('https://secret.test/?token=private');}};
  assert.throws(()=>createRequestBridge({remote,session:{}}),error=>!error.message.includes('private')&&error.message.includes('重新启用'));
  assert.throws(()=>createRequestBridge({session:{}}));
});

test('main bridge is used before native fallback and reports stages without credentials',async()=>{
  const calls=[],logs=[];
  const session={cookies:{get:async()=>[{name:'yuque_ctoken',value:'private-csrf-value'}]},fetch:()=>{throw new Error('Unexpected fallback');}};
  const bridge={request:async options=>{
    calls.push(options);
    return {status:200,text:'{"success":true}'};
  }};
  const client=new YuqueClient({session,bridge,net:{request:()=>{throw new Error('Unexpected remote net');}},logger:line=>logs.push(line)});
  const body=Buffer.from([0,1,255,5]);
  await client._request('POST','/api/upload/attach?ctoken=private-csrf-value',body,undefined,'multipart/form-data; boundary=plain');
  assert.equal(calls.length,1);assert.equal(calls[0].body,body);
  assert.equal(calls[0].headers['X-CSRF-Token'],'private-csrf-value');
  assert.match(logs[0],/开始请求：POST \/api\/upload\/attach/);
  assert.match(logs[1],/收到完整响应/);
  assert.equal(logs.some(line=>line.includes('private')||line.includes('ctoken')),false);
});

test('bridge failures preserve known codes and never retry failed writes',async()=>{
  for(const code of ['TIMEOUT','NETWORK_ERROR','REDIRECT_BLOCKED','RESPONSE_TOO_LARGE','CLOSED','INVALID_REQUEST','unknown-secret']){
    let calls=0;
    const session={cookies:{get:async()=>[{name:'yuque_ctoken',value:'private'}]},fetch:()=>{throw new Error('Unexpected retry');}};
    const bridge={request:async()=>{calls++;return {error:{code,message:'private-token-raw-network-error'}};}};
    const client=new YuqueClient({session,bridge});
    await assert.rejects(client._request('POST','/api/docs',{}),error=>{
      assert.equal(error.code,code==='unknown-secret'?'NETWORK_ERROR':code);
      assert.equal(error.message.includes('private'),false);
      if(code==='TIMEOUT')assert.match(error.message,/检查是否已写入/);
      return true;
    });
    assert.equal(calls,1);
  }
});

test('login timeout gives read-only advice and rejects malformed bridge responses',async()=>{
  const client=new YuqueClient({session:{},bridge:{request:async()=>({error:{code:'TIMEOUT'}})}});
  await assert.rejects(client.initialize('test-user'),error=>error.code==='TIMEOUT'&&!error.message.includes('是否已写入'));
  for(const value of [undefined,{status:200},{status:'200',text:'{}'}]){
    const malformed=new YuqueClient({session:{},bridge:{request:async()=>value}});
    await assert.rejects(malformed.initialize('test-user'),{code:'INCOMPATIBLE_RESPONSE'});
  }
});
