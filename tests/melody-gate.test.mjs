import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatEngine } from '../dist/engine.js';
import { BPM, BEAT_SECONDS, ROLE_NAMES, sound } from './audio-fixtures.mjs';

function melodySpy() {
  return {
    starts:[],scheduled:[],stops:0,resets:[],destroys:0,
    start(time,options){this.starts.push({time,options});},
    schedule(until){this.scheduled.push(until);},
    stop(){this.stops++;},
    reset(seed){this.resets.push(seed);},
    destroy(){this.destroys++;},
  };
}
function engineFixture() {
  const context={
    state:'running',currentTime:7,sampleRate:48000,
    createBuffer(channels,length,sampleRate) {
      const pcm=new Float32Array(length);
      return {length,sampleRate,duration:length/sampleRate,copyToChannel(input){pcm.set(input);},getChannelData(){return pcm;}};
    },
  };
  const engine=new BeatEngine();
  Object.assign(engine,{context,state:'running',master:{},stream:{},_graphReady:true,_audioReady:true,_melodyReady:true,melody:melodySpy()});
  engine._play=()=>true;
  return engine;
}
function capture(engine,role) {
  const pcm=sound(role);
  engine._acceptSample({pcm,sampleRate:48000,peak:.5});
}
function assertOnBar(engine,event) {
  const bars=(event.time-engine.origin)/(BEAT_SECONDS*4);
  assert.ok(Math.abs(bars-Math.round(bars))<1e-9,'keyboard entry is aligned with the shared four-beat bar');
  assert.ok(event.time>engine.context.currentTime,'entry is scheduled ahead of the audio clock');
  assert.ok(event.time>=Math.max(...engine.samples.flat().map(sample=>sample.activeAt)),'the final recording finishes placement before keyboard entry');
  assert.equal(event.options.bpm,BPM,'keyboard and microphone loops share 110 BPM');
}

test('the keyboard waits for all six microphone rows and starts once on a shared bar',()=>{
  const engine=engineFixture();
  try {
    for(const role of ROLE_NAMES.slice(0,-1)) {
      capture(engine,role);
      engine.context.currentTime+=.41;
      engine._schedule();
      assert.equal(engine.melody.starts.length,0,`keyboard stays silent before ${role} completes the full ensemble`);
    }
    capture(engine,ROLE_NAMES.at(-1));
    engine._schedule();
    assert.ok(engine.samples.every(bank=>bank.length>0));
    assert.equal(engine.melody.starts.length,1);
    assertOnBar(engine,engine.melody.starts[0]);
    for(let tick=0;tick<12;tick++){
      engine.context.currentTime+=.025;
      engine._schedule();
    }
    capture(engine,'desk-thud');
    engine._schedule();
    assert.equal(engine.melody.starts.length,1,'new recordings and scheduler ticks do not restart an active melody');
    assert.ok(engine.melody.scheduled.length>0,'the common lookahead scheduler drives keyboard notes');
    assert.ok(Math.abs(engine.melody.scheduled.at(-1)-engine.context.currentTime-.11)<1e-9);
  } finally {engine._stopTransport();}
});

test('every individual missing role keeps the keyboard silent, even if the other five banks exist',()=>{
  for(let missing=0;missing<6;missing++) {
    const engine=engineFixture();engine.origin=6;
    try {
      engine.samples=Array.from({length:6},(_,lane)=>lane===missing?[]:[{id:lane,lane,steps:[0],activeAt:6,duration:1}]);
      engine._maybeStartMelody();
      assert.equal(engine.melody.starts.length,0,`missing ${ROLE_NAMES[missing]} is still an incomplete ensemble`);
    } finally {engine._stopTransport();}
  }
});

test('six repeated everyday sounds can complete the ensemble and start the keyboard on the next bar',()=>{
  for(const kind of ['phone-clap','desk-thud','percussion']) {
    const engine=engineFixture();
    try {
      for(let index=0;index<6;index++) {
        capture(engine,kind);
        engine.context.currentTime+=.2;
        engine._schedule();
        assert.equal(engine.samples.filter(bank=>bank.length).length,index+1);
        assert.equal(engine.melody.starts.length,index===5?1:0,'five recordings cannot bypass the gate; the sixth completes it');
      }
      assert.ok(engine.samples.every(bank=>bank.length>0));
      assertOnBar(engine,engine.melody.starts[0]);
      for(let index=0;index<8;index++) {
        capture(engine,kind);
        engine._schedule();
      }
      assert.equal(engine.melody.starts.length,1,'later captures improve the beat without restarting its accompaniment');
    } finally {engine._stopTransport();}
  }
});

test('pausing cancels keyboard playback and resuming re-enters once on the new transport bar',()=>{
  const engine=engineFixture();
  try {
    ROLE_NAMES.forEach(role=>capture(engine,role));
    engine._schedule();
    assert.equal(engine.melody.starts.length,1);
    const scheduled=engine.melody.scheduled.length;
    engine._stopTransport();engine.state='suspended';
    assert.ok(engine.melody.stops>0);
    engine.context.currentTime+=3;
    engine._schedule();
    assert.equal(engine.melody.scheduled.length,scheduled,'a suspended transport schedules neither new keyboard nor sample notes');
    engine._resumeTransport();
    assert.equal(engine.melody.starts.length,2);
    assertOnBar(engine,engine.melody.starts[1]);
    engine._schedule();
    assert.equal(engine.melody.starts.length,2);
  } finally {engine._stopTransport();}
});

test('reset cancels the melody and requires six fresh roles before another start',()=>{
  const engine=engineFixture();
  try {
    ROLE_NAMES.forEach(role=>capture(engine,role));
    engine._schedule();
    assert.equal(engine.melody.starts.length,1);
    engine.context.state='suspended';
    engine.reset();
    assert.equal(engine.melody.resets.length,1);
    assert.ok(engine.melody.stops>0);
    assert.ok(engine.samples.every(bank=>bank.length===0));
    assert.equal(engine.anchorSampleId,null);
    engine.context.state='running';engine.state='running';
    engine._schedule();
    assert.equal(engine.melody.starts.length,1,'a prepared keyboard cannot bypass the emptied gate');
    ROLE_NAMES.slice(0,-1).forEach(role=>capture(engine,role));
    engine._schedule();
    assert.equal(engine.melody.starts.length,1);
    capture(engine,ROLE_NAMES.at(-1));
    engine._schedule();
    assert.equal(engine.melody.starts.length,2);
    assertOnBar(engine,engine.melody.starts[1]);
  } finally {engine._stopTransport();}
});

test('keyboard readiness can finish after collection without duplicate or off-grid starts',()=>{
  const engine=engineFixture();engine._melodyReady=false;
  try {
    ROLE_NAMES.forEach(role=>capture(engine,role));
    engine._schedule();
    assert.equal(engine.melody.starts.length,0);
    engine.context.currentTime+=.9;
    engine._melodyReady=true;
    engine._maybeStartMelody();
    engine._maybeStartMelody();
    assert.equal(engine.melody.starts.length,1);
    assertOnBar(engine,engine.melody.starts[0]);
  } finally {engine._stopTransport();}
});

test('only a sustained stable bass can guide keyboard key without changing the recording',()=>{
  const engine=engineFixture();
  try {
    capture(engine,'kick');
    capture(engine,'desk-thud');
    assert.equal(engine.samples[2].length,1,'the second low impact uses the compatible bass role');
    assert.equal(engine._melodyRoot(),undefined,'a short desk resonance is not a dependable musical key');
    for(const role of ['clap','closed-hat','open-hat','percussion'])capture(engine,role);
    capture(engine,'bass');
    const bass=engine.samples[2].at(-1);
    const before=bass.buffer.getChannelData(0).slice();
    const root=engine._melodyRoot();
    assert.ok(Number.isInteger(root)&&root>=48&&root<60,'stable sustained bass can provide a keyboard pitch class');
    assert.deepEqual(bass.buffer.getChannelData(0),before,'key selection leaves the microphone recording unpitched');
    bass.classification.features.pitchSpreadCents=200;
    assert.equal(engine._melodyRoot(),undefined,'a wandering or noisy low pitch cannot force the keyboard key');
  } finally {engine._stopTransport();}
});
