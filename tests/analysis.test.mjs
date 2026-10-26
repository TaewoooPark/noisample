import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSample, classifySample } from '../dist/analysis.js';
import { ROLE_NAMES, sound } from './audio-fixtures.mjs';

for(const sampleRate of [44100,48000]) {
  test(`frequency and envelope analysis distinguish the six roles at ${sampleRate} Hz`,()=>{
    for(const [lane,role] of ROLE_NAMES.entries()) {
      const pcm=sound(role,sampleRate);
      const before=pcm.slice();
      const classified=classifySample(pcm,sampleRate);
      assert.equal(classified.lane,lane,`${role} has its own acoustic role`);
      assert.equal(classified.role,role);
      assert.ok(classified.compatibleLanes.includes(lane));
      assert.ok(classified.confidence>0&&classified.confidence<=1);
      assert.ok(Object.values(classified.features).every(Number.isFinite));
      assert.deepEqual(pcm,before,'spectral analysis must not mutate the recording');
    }
    const impact=analyzeSample(sound('desk-thud',sampleRate),sampleRate);
    const bass=analyzeSample(sound('bass',sampleRate),sampleRate);
    assert.ok(impact.lowRatio>.7&&bass.lowRatio>.7,'both low fixtures actually contain low-frequency bodies');
    assert.ok(bass.activeDuration>impact.activeDuration*3,'sustain is measured from the sound, not the complete capture window');
    assert.ok(bass.sustainRatio>impact.sustainRatio);
    assert.equal(classifySample(sound('desk-thud',sampleRate),sampleRate).lane,0,'a weak noisy attack does not turn a low desk impact into a hat');
    const shortHat=analyzeSample(sound('closed-hat',sampleRate),sampleRate);
    const openHat=analyzeSample(sound('open-hat',sampleRate),sampleRate);
    assert.ok(shortHat.highRatio>.8&&openHat.highRatio>.8);
    assert.ok(openHat.activeDuration>shortHat.activeDuration*3);
  });

  test(`a phone-band clap remains a clap despite quiet upper frequencies at ${sampleRate} Hz`,()=>{
    const pcm=sound('phone-clap',sampleRate);
    const classified=classifySample(pcm,sampleRate);
    assert.ok(classified.features.flatness<.09,'fixture exercises the low-flatness, band-limited noise case');
    assert.ok(classified.features.spectralEntropy>.65,'its audible band remains broadband noise');
    assert.equal(classified.lane,1);
    assert.equal(classified.role,'clap');
    assert.ok(classified.features.centroid>900&&classified.features.centroid<6000);
  });
}

test('six ordinary repeated sounds fill six distinct roles while keeping their natural role first',()=>{
  for(const [kind,naturalLane] of [['phone-clap',1],['desk-thud',0],['percussion',5]]) {
    const counts=[0,0,0,0,0,0];
    const pcm=sound(kind);
    const original=pcm.slice();
    let fallbackCount=0;
    for(let index=0;index<6;index++) {
      const result=classifySample(pcm,48000,counts,index ? [naturalLane] : []);
      if(index===0)assert.equal(result.lane,naturalLane,'the first sound keeps its best acoustic role');
      assert.equal(counts[result.lane],0,'each captured sound makes progress on an empty row');
      assert.equal(result.assignment,result.compatibleLanes.includes(result.lane)?'matched':'fill');
      assert.ok(Number.isFinite(result.matchScore)&&result.matchScore>0&&result.matchScore<=1);
      if(result.assignment==='fill')fallbackCount++;
      counts[result.lane]++;
    }
    assert.deepEqual(counts,[1,1,1,1,1,1],`${kind} alone can complete the instrument`);
    assert.ok(fallbackCount>0,'fallback roles prevent acoustic classification from blocking completion');
    assert.deepEqual(pcm,original,'permissive placement still never changes microphone PCM');
  }
});

test('natural acoustic roles win when both matched and fallback vacancies are available',()=>{
  for(const role of ROLE_NAMES) {
    const pcm=sound(role);
    const first=classifySample(pcm,48000);
    const counts=Array(6).fill(1);
    counts[first.lane]=0;
    counts[(first.lane+1)%6]=0;
    const selected=classifySample(pcm,48000,counts);
    assert.equal(selected.lane,first.lane);
    assert.equal(selected.assignment,'matched');
    assert.equal(classifySample(pcm,48000,Array(6).fill(1)).assignment,'matched','a complete instrument returns to natural matches for updates');
  }
});

test('excluded anchor roles allow fallback placement, but excluding every row returns no assignment',()=>{
  for(const role of ROLE_NAMES) {
    const pcm=sound(role);
    const first=classifySample(pcm,48000);
    const fallback=classifySample(pcm,48000,[0,0,0,0,0,0],first.compatibleLanes);
    assert.ok(Number.isInteger(fallback.lane));
    assert.ok(!first.compatibleLanes.includes(fallback.lane));
    assert.equal(fallback.assignment,'fill');
    const excluded=classifySample(pcm,48000,[0,0,0,0,0,0],[0,1,2,3,4,5]);
    assert.equal(excluded.lane,null);
    assert.equal(excluded.role,null);
  }
});

test('analysis stays finite for silence and very short captures without changing their PCM',()=>{
  for(const pcm of [new Float32Array(),new Float32Array(48000),new Float32Array([.1]),new Float32Array([.1,-.1,.2])]) {
    const before=pcm.slice();
    assert.ok(Object.values(analyzeSample(pcm,48000)).every(Number.isFinite));
    assert.deepEqual(pcm,before);
  }
});
