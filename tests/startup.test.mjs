import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatEngine } from '../dist/engine.js';
import { MelodyEngine } from '../dist/melody.js';
import { BEAT_SECONDS, ROLE_NAMES, sound } from './audio-fixtures.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate, milliseconds = 300) {
  const began = performance.now();
  while (!predicate()) {
    if (performance.now() - began > milliseconds) throw new Error('Expected browser state did not arrive');
    await new Promise(resolve => setTimeout(resolve,5));
  }
}
async function bounded(promise, milliseconds = 300) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Startup did not settle; a browser promise blocked progress')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type) { for (const handler of this.listeners.get(type) || []) handler({type}); }
}

function fixture(options = {}) {
  const calls = [];
  const contexts = [];
  const tracks = [];
  const streams = [];
  const doc = Object.assign(new Events(), { hidden: false });
  let permissionCalls = 0;
  function stream() {
    const track = Object.assign(new Events(), {
      readyState: 'live', muted: false, enabled: true, stops: 0,
      stop() { this.stops++; this.readyState = 'ended'; }
    });
    tracks.push(track);
    const media = {getTracks: () => [track], getAudioTracks: () => [track]};
    streams.push(media);
    return media;
  }
  const parameter = (value = 1) => ({value, setValueAtTime(next) {this.value = next;}, linearRampToValueAtTime(next) {this.value = next;}});
  const node = () => Object.assign(new Events(), {
    connections: [], connect(target) {this.connections.push(target); return target;}, disconnect() {this.connections = [];}
  });
  class Context extends Events {
    constructor() {
      super();
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.destination = node();
      this.resumeCalls = 0;
      this.closeCalls = 0;
      this.suspendCalls = 0;
      this.nodes = [];
      this._clockStart = performance.now();
      this.audioWorklet = {addModule: url => {
        calls.push('module');
        return options.module ? options.module(this, url) : Promise.resolve();
      }};
      contexts.push(this); calls.push('context');
    }
    get currentTime() {
      if(options.clock)return options.clock(this);
      return this.state === 'running' ? (performance.now() - this._clockStart) / 1000 : 0;
    }
    setState(state) {
      if(this.state===state)return;
      this.state = state;
      this.onstatechange?.({type:'statechange'});
      this.emit('statechange');
    }
    resume() {
      this.resumeCalls++; calls.push('resume');
      if (options.resume) return options.resume(this, this.resumeCalls);
      this.setState('running'); return Promise.resolve();
    }
    suspend() {this.suspendCalls++; this.setState('suspended'); return Promise.resolve();}
    close() {this.closeCalls++; this.setState('closed'); for (const n of this.nodes) n.disconnect(); return Promise.resolve();}
    createMediaStreamSource(media) {calls.push('input'); this.connectedStream = media; return node();}
    createAnalyser() {return Object.assign(node(), {fftSize:2048, getFloatTimeDomainData(target) {target.fill(0);}});}
    createGain() {return Object.assign(node(), {gain:parameter(1)});}
    createBuffer(channels, length, rate) {
      const pcm = new Float32Array(length);
      return {duration:length/rate, length, sampleRate:rate, getChannelData:() => pcm, copyToChannel(input) {pcm.set(input);}};
    }
    createBufferSource() {return Object.assign(node(), {playbackRate:parameter(1), detune:parameter(0), start() {}, stop() {}});}
  }
  class Worklet extends Events {
    constructor(context) {
      super();
      calls.push('worklet'); this.context = context; context.nodes.push(this);
      this.generation = 0;
      this.port = {onmessage:null, postMessage: data => {if (data.type === 'reset') this.generation = data.generation;}};
      this.timer = setInterval(() => {
        if(options.heartbeat && !options.heartbeat(context))return;
        if (context.state === 'running') this.port.onmessage?.({data:{type:'level', generation:this.generation, rms:.002, peak:.003, capturing:false}});
      }, 10);
      this.timer.unref();
    }
    connect() {}
    disconnect() {clearInterval(this.timer);}
  }
  const navigator = {mediaDevices:{getUserMedia() {
    calls.push('permission'); permissionCalls++;
    return options.permission ? options.permission(permissionCalls, stream) : Promise.resolve(stream());
  }}};
  return {doc, Context, Worklet, navigator, contexts, tracks, streams, calls, stream, get permissionCalls() {return permissionCalls;}};
}

async function runWith(f, run) {
  const overrides = {isSecureContext:true, document:f.doc, navigator:f.navigator, AudioContext:f.Context, AudioWorkletNode:f.Worklet};
  const original = new Map();
  for (const [key,value] of Object.entries(overrides)) {
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const engines = [];
  try {await run(callbacks => {const engine = new BeatEngine(callbacks); engines.push(engine); return engine;});}
  finally {
    for (const engine of engines) await engine.destroy();
    for (const context of f.contexts) if (context.state !== 'closed') await context.close();
    for (const [key,descriptor] of original) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
}

test('permission can finish startup even when the first iOS resume promise never resolves', async () => {
  const never = new Promise(() => {});
  const f = fixture({resume(context, count) {
    if (count === 1) {context.setState('interrupted'); return never;}
    context.setState('running'); return Promise.resolve();
  }});
  await runWith(f, async create => {
    const engine = create();
    await bounded(engine.start());
    await turn();
    assert.equal(f.permissionCalls,1);
    assert.ok(f.calls.indexOf('resume') < f.calls.indexOf('permission'),'initial unlock remains within the first gesture');
    assert.ok(f.calls.includes('worklet'),'permission acceptance builds the microphone graph without awaiting the stale resume');
    assert.equal(engine.state,'running');
    assert.equal(engine.stream,f.streams[0]);
  });
});

test('another gesture while permission is pending retries audio unlock without a second microphone request', async () => {
  const permission = deferred();
  const f = fixture({permission:() => permission.promise});
  await runWith(f, async create => {
    const engine = create();
    const first = engine.start();
    const context = f.contexts[0];
    context.setState('interrupted');
    const resumesBefore = context.resumeCalls;
    const second = engine.start();
    assert.ok(context.resumeCalls > resumesBefore,'the retry gesture must reach resume synchronously');
    assert.equal(f.permissionCalls,1,'permission prompts are coalesced');
    permission.resolve(f.stream());
    await bounded(Promise.all([first,second]));
    assert.equal(engine.state,'running');
    assert.equal(f.contexts.length,1);
  });
});

test('a context that remains suspended after permission settles can recover on a later touch without reload', async () => {
  let allowed = false;
  const f = fixture({resume(context) {
    if (!allowed) return new Promise(() => {});
    context.setState('running'); return Promise.resolve();
  }});
  await runWith(f, async create => {
    const engine = create();
    await bounded(engine.start(),2000);
    assert.ok(f.calls.includes('worklet'),'the capture graph is prepared independently of playback permission');
    assert.notEqual(engine.state,'requesting','a granted microphone cannot leave an indefinite requesting spinner');
    allowed = true;
    await bounded(engine.start());
    await waitFor(()=>engine.state==='running');
    assert.equal(engine.state,'running');
    assert.equal(f.permissionCalls,1,'an unlocked retry reuses the granted stream');
  });
});

test('returning from a permission interruption reuses the stream and starts transport', async () => {
  const permission = deferred();
  const f = fixture({permission:() => permission.promise});
  await runWith(f, async create => {
    const engine = create();
    const starting = engine.start();
    f.doc.hidden = true; f.doc.emit('visibilitychange');
    f.contexts[0].setState('interrupted');
    permission.resolve(f.stream());
    await bounded(starting);
    f.doc.hidden = false; f.doc.emit('visibilitychange');
    await waitFor(()=>engine.state==='running');
    assert.equal(engine.state,'running');
    assert.equal(f.permissionCalls,1);
  });
});

test('permission denial can be retried in place with a fresh context', async () => {
  const f = fixture({permission(count, stream) {
    return count === 1 ? Promise.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'})) : Promise.resolve(stream());
  }});
  await runWith(f, async create => {
    const engine = create();
    await assert.rejects(bounded(engine.start()),{name:'NotAllowedError'});
    assert.equal(engine.state,'denied');
    assert.equal(f.contexts[0].state,'closed');
    await bounded(engine.start());
    assert.equal(engine.state,'running');
    assert.equal(f.permissionCalls,2);
    assert.equal(f.contexts.length,2);
  });
});

test('closing during worklet loading releases the granted microphone and ignores the late module result', async () => {
  const module = deferred();
  const f = fixture({module:() => module.promise});
  await runWith(f, async create => {
    const engine = create();
    const starting = engine.start();
    await turn();
    assert.ok(f.calls.includes('module'));
    await engine.destroy();
    module.resolve();
    await bounded(starting);
    assert.equal(engine.state,'idle');
    assert.equal(engine.context,null);
    assert.equal(engine.stream,null);
    assert.equal(f.tracks[0].readyState,'ended');
    assert.ok(!f.calls.includes('worklet'),'a destroyed session cannot reconnect a late audio graph');
  });
});

test('resetting a live session clears its samples without requesting microphone permission again', async () => {
  const f = fixture();
  await runWith(f, async create => {
    const engine = create();
    await bounded(engine.start());
    const context = engine.context;
    const stream = engine.stream;
    engine.samples[0].push({id:1,duration:1,steps:[0]});
    engine.reset();
    await bounded(engine.start());
    assert.equal(engine.context,context);
    assert.equal(engine.stream,stream);
    assert.equal(f.permissionCalls,1);
    assert.equal(f.tracks[0].stops,0);
    assert.ok(engine.samples.every(bank => bank.length === 0));
    assert.equal(engine.state,'running');
  });
});

test('a late worklet failure after closing cannot change the closed session back into an error', async () => {
  const module = deferred();
  const f = fixture({module:() => module.promise});
  await runWith(f, async create => {
    const states=[];
    const engine = create({onState: state => states.push(state)});
    const starting = engine.start();
    const settled = starting.catch(error => error);
    await turn();
    await engine.destroy();
    const count=states.length;
    module.reject(new Error('late worklet network failure'));
    await bounded(settled);
    assert.equal(engine.state,'idle');
    assert.equal(engine.context,null);
    assert.equal(engine.stream,null);
    assert.deepEqual(states.slice(count),[],'the late rejected promise cannot revive or overwrite a disposed session');
    assert.equal(f.tracks[0].readyState,'ended');
  });
});

test('reset during permission wait keeps one request and initializes the resulting graph with the new generation', async () => {
  const permission = deferred();
  const f = fixture({permission:() => permission.promise});
  await runWith(f, async create => {
    const engine=create();
    const starting=engine.start();
    engine.samples[0].push({id:1,duration:1,steps:[0]});
    engine.reset();
    const afterReset=engine.start();
    permission.resolve(f.stream());
    await bounded(Promise.all([starting,afterReset]));
    assert.equal(f.permissionCalls,1);
    assert.equal(engine.generation,1);
    assert.ok(engine.samples.every(bank=>bank.length===0));
    assert.equal(engine.captureNode.generation,engine.generation,'a delayed graph must not reintroduce samples from before reset');
    assert.equal(engine.state,'running');
  });
});

for (const stalledState of ['interrupted','running']) {
  test(`a persistently ${stalledState} audio route is rebuilt on touch while retaining microphone permission`, async () => {
    const f=fixture({
      resume(context) {
        if(context===f.contexts[0]) {
          context.setState(stalledState);
          return new Promise(()=>{});
        }
        context.setState('running');return Promise.resolve();
      },
      clock(context) {return context===f.contexts[0]?0:(performance.now()-context._clockStart)/1000;},
      heartbeat(context) {return context!==f.contexts[0];}
    });
    await runWith(f,async create=>{
      const engine=create();
      await bounded(engine.start(),2000);
      const microphone=engine.stream;
      assert.equal(engine.state,'suspended','a frozen audio route must not be presented as running');
      await bounded(engine.start());
      assert.equal(engine.state,'running');
      assert.equal(f.contexts.length,2,'retry replaces the exhausted audio context');
      assert.equal(f.contexts[0].closeCalls,1);
      assert.equal(f.contexts[0].state,'closed');
      assert.equal(engine.stream,microphone,'a fresh graph keeps the already-granted microphone');
      assert.equal(f.permissionCalls,1);
      assert.equal(f.tracks[0].stops,0);
      assert.equal(f.contexts[1].connectedStream,microphone);
    });
  });
}

test('rebuilding the audio clock rebases retained sample activation so existing beats resume promptly', async () => {
  let newClock=0;
  const f=fixture({
    resume(context) {
      if(context===f.contexts[0]){context.setState('interrupted');return new Promise(()=>{});}
      context.setState('running');return Promise.resolve();
    },
    clock: context=>context===f.contexts[0]?100:newClock,
    heartbeat: context=>context!==f.contexts[0]
  });
  await runWith(f,async create=>{
    const engine=create();
    await bounded(engine.start(),2000);
    const pcm=sound('clap',48000,1);
    engine._acceptSample({pcm,sampleRate:48000,peak:.2});
    const anchor=engine.samples.flat().find(sample=>sample.isAnchor);
    assert.ok(anchor.activeAt>=100,'the recording belongs to the original audio clock');
    await bounded(engine.start());
    assert.equal(engine.samples[anchor.lane][0],anchor,'recovery keeps the collected sound');
    assert.deepEqual(anchor.buffer.getChannelData(0),pcm);
    const hits=[];
    engine._play=(sample,time)=>{hits.push({sample,time});return true;};
    for(newClock=0;newClock<1.1;newClock+=.025)engine._schedule();
    assert.ok(hits.length>=2,'retained recordings must not wait for the old 100-second activation timestamp');
    assert.equal(hits[0].sample,anchor);
    assert.ok(hits[0].time<.5,'the first returning beat occurs promptly on the replacement clock');
    assert.ok(Math.abs(hits[1].time-hits[0].time-BEAT_SECONDS)<1e-8);
  });
});

test('reacquiring an ended microphone rebases existing recordings on the fresh audio clock',async()=>{
  let newClock=0;
  const f=fixture({clock:context=>context===f.contexts[0]?120:newClock});
  await runWith(f,async create=>{
    const engine=create();
    await bounded(engine.start());
    const originalContext=engine.context;
    const originalStream=engine.stream;
    const pcm=sound('clap',48000,1);
    engine._acceptSample({pcm,sampleRate:48000,peak:.5});
    engine._acceptSample({pcm:sound('kick'),sampleRate:48000,peak:.5});
    const samples=engine.samples.flat();
    const anchor=samples.find(sample=>sample.isAnchor);
    assert.ok(samples.every(sample=>sample.activeAt>=120),'the collected sounds use the first context clock');
    f.tracks[0].stop();
    f.tracks[0].emit('ended');
    assert.equal(engine.state,'error');
    const hits=[];
    engine._play=(sample,time)=>{hits.push({sample,time});return true;};
    await bounded(engine.start());
    assert.equal(f.permissionCalls,2,'this recovery acquires a fresh microphone, rather than retaining the old stream');
    assert.notEqual(engine.context,originalContext);
    assert.notEqual(engine.stream,originalStream);
    assert.equal(originalContext.state,'closed');
    assert.equal(engine.state,'running');
    assert.deepEqual(engine.samples.flat(),samples,'microphone reacquisition preserves the collected recordings and anchor');
    assert.ok(samples.every(sample=>sample.activeAt===0),'all previous activation timestamps are rebased, including the fresh-permission path');
    assert.deepEqual(anchor.buffer.getChannelData(0),pcm);
    for(newClock=0;newClock<1.1;newClock+=.025)engine._schedule();
    assert.ok(samples.every(sample=>hits.some(hit=>hit.sample===sample)),'existing roles begin playing on the replacement clock');
    const pulse=hits.filter(hit=>hit.sample===anchor);
    assert.ok(pulse.length>=2,'the first sound does not wait for the old 120-second activation timestamp');
    assert.ok(pulse[0].time<.5);
    assert.ok(Math.abs(pulse[1].time-pulse[0].time-BEAT_SECONDS)<1e-8);
  });
});

function collectEveryRole(engine) {
  for(const role of ROLE_NAMES)engine._acceptSample({pcm:sound(role),sampleRate:48000,peak:.5});
  assert.ok(engine.samples.every(bank=>bank.length>0));
}

test('slow keyboard preparation never delays microphone startup and cannot bypass reset',async()=>{
  const pending=deferred();
  const original=MelodyEngine.prototype.prepare;
  MelodyEngine.prototype.prepare=function(){return pending.promise;};
  try {
    const f=fixture();
    await runWith(f,async create=>{
      const engine=create();
      await bounded(engine.start());
      assert.equal(engine.state,'running','sample downloads are not part of microphone startup readiness');
      const starts=[];
      engine.melody.start=(...args)=>starts.push(args);
      engine.melody.schedule=()=>{};
      collectEveryRole(engine);
      assert.equal(starts.length,0);
      engine.reset();
      pending.resolve();
      await turn();
      assert.equal(engine._melodyReady,true);
      assert.equal(starts.length,0,'a late prepared keyboard sees the fresh empty collection');
      collectEveryRole(engine);
      assert.equal(starts.length,1,'six newly collected roles can activate the prepared instance');
    });
  } finally {MelodyEngine.prototype.prepare=original;}
});

test('late preparation from an old audio context cannot ready or start the replacement keyboard',async()=>{
  const pending=[deferred(),deferred()];
  let preparations=0;
  const original=MelodyEngine.prototype.prepare;
  MelodyEngine.prototype.prepare=function(){return pending[preparations++].promise;};
  try {
    const f=fixture();
    await runWith(f,async create=>{
      const engine=create();
      await bounded(engine.start());
      collectEveryRole(engine);
      const previous=engine.melody;
      const stream=engine.stream;
      f.contexts[0].setState('closed');
      await bounded(engine.start());
      const replacement=engine.melody;
      assert.notEqual(replacement,previous);
      assert.equal(previous.destroyed,true);
      assert.equal(engine.stream,stream);
      assert.equal(f.permissionCalls,1);
      assert.equal(preparations,2);
      const starts=[];
      replacement.start=(time,options)=>starts.push({time,options});
      replacement.schedule=()=>{};
      pending[0].resolve();
      await turn();
      assert.equal(engine._melodyReady,false,'old preparation cannot mark the new instance ready');
      assert.equal(starts.length,0);
      pending[1].resolve();
      await turn();
      assert.equal(starts.length,1);
      assert.ok(engine.samples.flat().every(sample=>sample.activeAt===0));
      assert.ok(starts[0].time<engine.context.currentTime+BEAT_SECONDS*4+.15,'retained recordings start on the replacement clock');
      const bars=(starts[0].time-engine.origin)/(BEAT_SECONDS*4);
      assert.ok(Math.abs(bars-Math.round(bars))<1e-9);
    });
  } finally {MelodyEngine.prototype.prepare=original;}
});

test('closing during keyboard preparation prevents a late ready event or melody start',async()=>{
  const pending=deferred();
  const original=MelodyEngine.prototype.prepare;
  MelodyEngine.prototype.prepare=function(){return pending.promise;};
  try {
    const f=fixture();
    await runWith(f,async create=>{
      const states=[];
      const engine=create({onMelodyState:state=>states.push(state)});
      await bounded(engine.start());
      collectEveryRole(engine);
      let starts=0;
      engine.melody.start=()=>{starts++;};
      await engine.destroy();
      const count=states.length;
      pending.resolve();
      await turn();
      assert.equal(engine.context,null);
      assert.equal(engine.melody,null);
      assert.equal(engine._melodyReady,false);
      assert.equal(starts,0);
      assert.equal(states.length,count,'late preparation cannot emit a new ready state after teardown');
    });
  } finally {MelodyEngine.prototype.prepare=original;}
});
