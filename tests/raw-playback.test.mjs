import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatEngine, GROOVE_PRESETS, fitPatternSteps } from '../dist/engine.js';

function makeContext() {
  const sources=[];
  const gains=[];
  function parameter(value) {
    return {
      value, events:[],
      setValueAtTime(next,time){this.events.push({kind:'set',value:next,time});this.value=next;},
      linearRampToValueAtTime(next,time){this.events.push({kind:'linear',value:next,time});this.value=next;},
      exponentialRampToValueAtTime(){throw new Error('Raw sample playback must not apply a decay envelope');}
    };
  }
  return {
    currentTime:1.9,state:'running',sources,gains,
    createBuffer(channels,length,sampleRate) {
      assert.equal(channels,1);
      const pcm=new Float32Array(length);
      return {length,sampleRate,duration:length/sampleRate,
        copyToChannel(input,channel){assert.equal(channel,0);pcm.set(input);},
        getChannelData(channel){assert.equal(channel,0);return pcm;}
      };
    },
    createBufferSource() {
      const source={buffer:null,loop:false,playbackRate:parameter(1),detune:parameter(0),starts:[],stops:[],connections:[],
        connect(node){this.connections.push(node);},disconnect(){},addEventListener(){},
        start(...args){this.starts.push(args);},stop(...args){this.stops.push(args);}
      };
      sources.push(source);return source;
    },
    createGain() {
      const gain={gain:parameter(1),connections:[],connect(node){this.connections.push(node);},disconnect(){}};
      gains.push(gain);return gain;
    },
    createBiquadFilter(){throw new Error('Raw sample playback must not create a filter');},
    createDynamicsCompressor(){throw new Error('Raw sample playback must not create a compressor');},
    createWaveShaper(){throw new Error('Raw sample playback must not distort recordings');},
    createOscillator(){throw new Error('Raw sample playback must not substitute a synthesizer');}
  };
}

test('all six roles retain the entire captured PCM without normalization, trimming or resynthesis',()=>{
  const rate=48000;
  // Non-zero DC, a quiet opening and changing amplitudes expose normalization,
  // transient trimming and voice-specific shaping while using realistic PCM.
  const input=Float32Array.from({length:Math.round(rate*1.25)},(_,i)=>i<rate*.08 ? .011 : .11+(.12+.2*i/(rate*1.25))*Math.sin(i*.071));
  const original=input.slice();
  for(let targetLane=0;targetLane<6;targetLane++){
    let accepted;
    const engine=new BeatEngine({onCapture:sample=>accepted=sample});
    engine.context=makeContext();engine.origin=0;
    engine.samples=Array.from({length:6},(_,lane)=>lane===targetLane?[]:[{id:-lane-1,duration:1.25,steps:[]}]);
    engine._acceptSample({pcm:input,sampleRate:rate,peak:.5});
    assert.equal(accepted.lane,targetLane);
    assert.equal(accepted.duration,input.length/rate);
    assert.equal(accepted.buffer.duration,input.length/rate);
    assert.equal(accepted.buffer.sampleRate,rate);
    assert.deepEqual(accepted.buffer.getChannelData(0),original,`lane ${targetLane} preserves every captured sample`);
    assert.equal(accepted.grain,undefined,'roles must not receive tiny looped grains');
    assert.ok(accepted.steps.length>0);
    assert.ok(Number.isFinite(accepted.activeAt));
  }
  assert.deepEqual(input,original,'captured PCM is not mutated in place');
});

test('every role plays one complete recording at original pitch and speed with only click fades',()=>{
  for(let lane=0;lane<6;lane++){
    const engine=new BeatEngine();
    const context=makeContext();engine.context=context;engine.master={};engine.state='running';
    const buffer=context.createBuffer(1,72000,48000);
    buffer.copyToChannel(Float32Array.from({length:72000},(_,i)=>.3*Math.sin(i*.1)),0);
    const sample={id:lane+1,lane,buffer,duration:1.5,steps:[0]};
    try {
      engine._play(sample,2,.2,0,3);
      assert.equal(context.sources.length,1,'no layered attack or replacement voice');
      const source=context.sources[0];
      assert.equal(source.buffer,buffer,'the recorded buffer itself is the playback source');
      assert.equal(source.loop,false);
      assert.equal(source.playbackRate.value,1);
      assert.equal(source.detune.value,0);
      assert.ok(source.playbackRate.events.every(event=>event.value===1));
      assert.ok(source.detune.events.every(event=>event.value===0));
      assert.deepEqual(source.starts,[[2]],'no offset or shortened start duration');
      assert.ok(source.stops.every(([time])=>time>=2+buffer.duration),'the tail must not be truncated');
      assert.equal(context.gains.length,1,'one click-fade envelope only');
      const gain=context.gains[0];
      assert.equal(source.connections[0],gain);
      assert.equal(gain.connections[0],engine.master,'there is no intervening timbre-processing graph');
      const events=gain.gain.events;
      assert.ok(events.length>=4);
      assert.ok(events.every(event=>event.value===0||event.value===1),'no role-specific levels or decaying envelope');
      assert.ok(events.some(event=>event.value===1&&event.time<=2.004));
      assert.ok(events.some(event=>event.value===1&&event.time>=3.496),'full sustain remains until the final click fade');
      assert.ok(events.every(event=>event.time<=2.004||event.time>=3.496),'only the edges may alter the recording envelope');
    } finally {engine._stopTransport();}
  }
});

const onset=(step,swing)=>step*.125+(step%2?.125*swing:0);
function verifyCyclicFit(steps,duration,swing) {
  const sorted=[...steps].sort((a,b)=>a-b);
  assert.ok(sorted.length>0);
  assert.equal(new Set(sorted).size,sorted.length);
  for(let i=0;i<sorted.length;i++){
    const current=onset(sorted[i],swing);
    const next=onset(sorted[(i+1)%sorted.length],swing)+(i===sorted.length-1?4:0);
    assert.ok(next-current+1e-9>=duration+.003,`clip ${duration}s must fit ${current} → ${next}, including wraparound`);
  }
}

test('long recordings fit original groove onsets without overlapping across the loop boundary',()=>{
  for(const preset of GROOVE_PRESETS){
    for(const pattern of preset.lanes){
      for(const duration of [.8,.9,1.2,1.55,1.8]){
        const steps=fitPatternSteps(pattern,duration,preset.swing);
        assert.ok(steps.every(step=>pattern.includes(step)),'roles retain positions from their rhythm preset');
        verifyCyclicFit(steps,duration,preset.swing);
        assert.deepEqual(fitPatternSteps(pattern,duration,preset.swing),steps,'spacing choices are deterministic');
      }
    }
  }
});

test('different-length recordings keep nonempty, unique, fully playable lane assignments',()=>{
  for(const preset of GROOVE_PRESETS){
    for(let lane=0;lane<6;lane++){
      const engine=new BeatEngine();engine.preset=preset;
      engine.samples[lane]=[.8,1.2,1.8].map((duration,i)=>({id:i+1,duration,steps:[]}));
      engine._assignSteps(lane);
      const bank=engine.samples[lane];
      assert.ok(bank.length>0&&bank.length<=3);
      assert.ok(bank.every(sample=>sample.steps.length>0),'no invisible or inaudible bank entry');
      const hits=bank.flatMap(sample=>sample.steps.map(step=>({step,duration:sample.duration}))).sort((a,b)=>a.step-b.step);
      assert.equal(new Set(hits.map(hit=>hit.step)).size,hits.length);
      assert.ok(hits.every(hit=>preset.lanes[lane].includes(hit.step)));
      for(let i=0;i<hits.length;i++){
        const current=onset(hits[i].step,preset.swing);
        const next=onset(hits[(i+1)%hits.length].step,preset.swing)+(i===hits.length-1?4:0);
        assert.ok(next-current+1e-9>=hits[i].duration+.003,'samples play to completion at their original speed');
      }
    }
  }
});
