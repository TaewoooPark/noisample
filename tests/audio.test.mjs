import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BeatEngine, GROOVE_PRESETS, chooseLane, waveformPeaks } from '../dist/engine.js';
import { BPM, STEP_SECONDS, sound } from './audio-fixtures.mjs';

const source = await fs.readFile(new URL('../dist/capture-worklet.js', import.meta.url), 'utf8');
function detector(sampleRate = 48000, quantum = 128) {
  const messages = [];
  let Processor;
  const context = vm.createContext({
    sampleRate, currentTime: 0, Float32Array, Math,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor(name, constructor) { assert.equal(name, 'peak-capture'); Processor = constructor; }
  });
  vm.runInContext(source, context);
  const processor = new Processor();
  let frame = 0;
  function feed(seconds, signal = () => 0) {
    const frames = Math.round(seconds * sampleRate);
    for (let offset = 0; offset < frames; offset += quantum) {
      const size = Math.min(quantum, frames - offset);
      const input = Float32Array.from({length:size}, (_, i) => signal((frame + i) / sampleRate, i, offset));
      const output = new Float32Array(size).fill(1);
      context.currentTime = frame / sampleRate;
      assert.equal(processor.process([[input]], [[output]]), true);
      assert.ok(output.every(value => value === 0), 'raw microphone audio must never be monitored');
      frame += size;
    }
  }
  return {processor, messages, feed, captures: () => messages.filter(message => message.type === 'capture')};
}
const tone = (amplitude, frequency=440) => time => amplitude * Math.sin(2 * Math.PI * frequency * time);
function noise(amplitude) {
  let seed = 2433;
  return () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return amplitude*(seed/4294967296*2-1); };
}

for (const sampleRate of [44100,48000]) {
  test(`silence and low room noise are ignored at ${sampleRate} Hz`, () => {
    const d=detector(sampleRate);
    d.feed(1);d.feed(1,noise(.008));
    assert.equal(d.captures().length,0);
    assert.ok(d.messages.filter(m=>m.type==='level').length < 65, 'level messages are bounded near 30 Hz');
  });
  test(`isolated transient retains preroll and emits once at ${sampleRate} Hz`, () => {
    const d=detector(sampleRate);
    d.feed(.2);d.feed(.06,tone(.6));d.feed(.9);
    assert.equal(d.captures().length,1);
    const capture=d.captures()[0];
    assert.equal(capture.sampleRate,sampleRate);
    assert.equal(capture.generation,0);
    assert.ok(capture.pcm.length>=sampleRate*.8 && capture.pcm.length<=sampleRate*1.8);
    assert.ok(capture.pcm.subarray(0,Math.floor(sampleRate*.02)).every(v=>v===0), 'pre-roll contains preceding silence');
    assert.ok(capture.pcm.some(v=>Math.abs(v)>.5));
  });
}

test('a sustained tone is captured once, then a new sound can retrigger after quiet',()=>{
  const d=detector();d.feed(.2);d.feed(2,tone(.3));
  assert.equal(d.captures().length,1);
  d.feed(.5);d.feed(.06,tone(.6,1500));d.feed(.9);
  assert.equal(d.captures().length,2);
});
test('a short repeated transient during cooldown does not become a duplicate sample',()=>{
  const d=detector();d.feed(.2);d.feed(.04,tone(.6));d.feed(.80);d.feed(.04,tone(.6));d.feed(.9);
  assert.equal(d.captures().length,1);
});
test('reset abandons a partial sample and tags all later samples with the new generation',()=>{
  const d=detector();d.feed(.2);d.feed(.04,tone(.6));
  d.processor.port.onmessage({data:{type:'reset',generation:7}});
  d.feed(.4);assert.equal(d.captures().length,0);
  d.feed(.06,tone(.6));d.feed(.9);
  assert.equal(d.captures().length,1);assert.equal(d.captures()[0].generation,7);
});
test('render quanta may differ from 128 samples and still retain transient audio',()=>{
  for(const quantum of [64,256,511]) {
    const d=detector(48000,quantum);d.feed(.2);d.feed(.06,tone(.6));d.feed(.9);
    assert.equal(d.captures().length,1);
  }
});
test('a louder peak remains detectable after sustained ambient noise',()=>{
  const d=detector();d.feed(.2);d.feed(3,noise(.07));
  const count=d.captures().length;
  d.feed(.08,tone(.7));d.feed(1.9,noise(.07));
  assert.equal(d.captures().length,count+1, 'room noise must not latch the detector closed forever');
});
test('the starter groove provides six simple unswung two-bar 4/4 lanes',()=>{
  assert.equal(GROOVE_PRESETS.length,1,'initial rhythm must be predictable rather than randomly complex');
  for(const preset of GROOVE_PRESETS) {
    assert.equal(preset.lanes.length,6);
    for(const lane of preset.lanes){
      assert.ok(lane.length>0);
      assert.ok(lane.every(step=>Number.isInteger(step)&&step>=0&&step<32));
      assert.equal(new Set(lane).size,lane.length);
    }
    assert.equal(preset.swing,0);
  }
});
test('a multi-syllable sound retains its later syllables and natural pause',()=>{
  const sampleRate=48000;
  const d=detector(sampleRate);
  d.feed(.2);
  d.feed(.15,tone(.6,300));
  d.feed(.13);
  d.feed(.22,tone(.35,700));
  d.feed(.16);
  d.feed(.35,tone(.45,1200));
  d.feed(.4);
  assert.equal(d.captures().length,1,'short gaps inside a phrase must not split it');
  const {pcm}=d.captures()[0];
  assert.ok(pcm.length>=sampleRate*1.2 && pcm.length<=sampleRate*1.8);
  assert.ok(pcm.subarray(Math.round(sampleRate*.8),Math.round(sampleRate*1.0)).some(value=>Math.abs(value)>.4),'the late syllable survives beyond the former 360 ms limit');
  assert.ok(pcm.subarray(Math.round(sampleRate*.20),Math.round(sampleRate*.28)).every(value=>value===0),'the internal pause stays silent instead of being removed');
  const expected=Float32Array.from({length:Math.round(sampleRate*.15)},(_,i)=>tone(.6,300)((Math.round(sampleRate*.2)+i)/sampleRate));
  assert.deepEqual(pcm.subarray(Math.round(sampleRate*.032),Math.round(sampleRate*.032)+expected.length),expected,'captured source samples retain their amplitude, pitch and phase');
});
test('a continuing sound is bounded to 1.8 seconds without a short drum cutoff',()=>{
  for(const sampleRate of [44100,48000]){
    const d=detector(sampleRate);
    d.feed(.2);d.feed(2.0,tone(.4,330));
    assert.equal(d.captures().length,1);
    const {pcm}=d.captures()[0];
    assert.equal(pcm.length,Math.round(sampleRate*1.8));
    assert.ok(pcm.subarray(Math.round(sampleRate*1.7)).some(value=>Math.abs(value)>.35),'recording continues through the end of its longer window');
  }
});
test('repeated low sounds never fill clap or hat lanes merely because they are empty',()=>{
  const counts=[0,0,0,0,0,0];
  const pcm=sound('kick');
  for(let i=0;i<18;i++){
    const lane=chooseLane(pcm,48000,counts);
    assert.ok([0,2].includes(lane),'a low desk thud stays in a compatible low-frequency role');
    counts[lane]++;
  }
  assert.ok(counts.every((count,lane)=>[0,2].includes(lane)||count===0));
});
test('waveform summaries are finite and bounded for silence, short clips and transients',()=>{
  for(const pcm of [new Float32Array(0),new Float32Array(256),new Float32Array([0,-.8,1,.2])]){
    const peaks=waveformPeaks(pcm);assert.equal(peaks.length,48);
    assert.ok(peaks.every(value=>Number.isFinite(value)&&value>=0&&value<=1));
  }
});
test('transport is exactly 110 BPM, wraps at 32 steps and clears all samples on reset',()=>{
  const engine=new BeatEngine();assert.equal(engine.bpm,BPM);
  engine.context={currentTime:16*STEP_SECONDS,state:'suspended'};engine.origin=0;engine.state='running';
  assert.equal(engine.getPosition(),16);
  engine.context.currentTime=33*STEP_SECONDS;assert.ok(Math.abs(engine.getPosition()-1)<1e-10);
  engine.samples[0].push({id:1});engine.reset();
  assert.ok(engine.samples.every(lane=>lane.length===0));assert.equal(engine.generation,1);
});
test('supporting sample banks remain bounded and every retained recording owns audible pattern steps',()=>{
  const engine=new BeatEngine();engine.preset=GROOVE_PRESETS[0];
  engine.context={currentTime:0,createBuffer(channels,length,sampleRate){return {duration:length/sampleRate,copyToChannel(){}};}};
  engine._acceptSample({pcm:sound('bass'),sampleRate:48000,peak:.35});
  const pcm=sound('open-hat');
  for(let repeat=0;repeat<12;repeat++){
    engine._acceptSample({pcm,sampleRate:48000,peak:.5});
    for(const bank of engine.samples)assert.ok(bank.length<=3,'sample memory stays bounded');
    const bank=engine.samples[4];
    assert.ok(bank.length>0);
    assert.ok(bank.every(sample=>sample.steps.length>0),'newly accepted samples must have playback steps');
    const steps=bank.flatMap(sample=>sample.steps);
    assert.equal(new Set(steps).size,steps.length,'one sample owns each lane step');
    assert.ok(steps.every(step=>engine.preset.lanes[4].includes(step)),'all retained onsets still belong to the selected groove');
    const sorted=[...steps].sort((a,b)=>a-b);
    for(let i=0;i<sorted.length;i++){
      const start=sorted[i]*STEP_SECONDS;
      const next=sorted[(i+1)%sorted.length]*STEP_SECONDS+(i===sorted.length-1?32*STEP_SECONDS:0);
      assert.ok(next-start>=1.2,'complete samples have room before the next onset, including the loop seam');
    }
  }
});

async function withBrowserMocks(overrides, run) {
  const original = new Map();
  for (const [key,value] of Object.entries(overrides)) {
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  try { await run(); }
  finally {for (const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
}
const documentMock={hidden:false,addEventListener(){},removeEventListener(){}};
test('permission denial closes the audio context and reports a recoverable denied state',async()=>{
  const calls=[];
  class Context {
    constructor(){this.state='suspended';calls.push('construct');}
    resume(){calls.push('resume');return Promise.resolve();}
    close(){calls.push('close');this.state='closed';return Promise.resolve();}
  }
  await withBrowserMocks({isSecureContext:true,AudioContext:Context,document:documentMock,navigator:{mediaDevices:{getUserMedia(){calls.push('permission');return Promise.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));}}}},async()=>{
    const engine=new BeatEngine();
    const promise=engine.start();
    assert.deepEqual(calls,['construct','resume','permission'],'context must unlock in the initial gesture before awaiting permission');
    await assert.rejects(promise,{name:'NotAllowedError'});
    assert.equal(engine.state,'denied');assert.equal(engine.context,null);assert.equal(engine.stream,null);
    assert.equal(calls.at(-1),'close');
    await engine.destroy();
  });
});
test('closing the page while permission is pending stops a subsequently granted microphone',async()=>{
  let resolvePermission,stopped=0,closed=0;
  class Context {
    constructor(){this.state='running';}
    resume(){return Promise.resolve();}
    close(){closed++;this.state='closed';return Promise.resolve();}
  }
  await withBrowserMocks({isSecureContext:true,AudioContext:Context,document:documentMock,navigator:{mediaDevices:{getUserMedia(){return new Promise(resolve=>{resolvePermission=resolve;});}}}},async()=>{
    const engine=new BeatEngine();const pending=engine.start();
    await engine.destroy();
    resolvePermission({getTracks(){return [{stop(){stopped++;}}];}});
    await pending;
    assert.equal(stopped,1);assert.equal(closed,1);assert.equal(engine.context,null);assert.equal(engine.stream,null);assert.equal(engine.state,'idle');
  });
});
