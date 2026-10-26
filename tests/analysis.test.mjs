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

test('repeated claps only occupy clap and hat roles even when all low roles are empty',()=>{
  for(const kind of ['clap','phone-clap']) {
    const counts=[0,0,0,0,0,0];
    const pcm=sound(kind);
    for(let index=0;index<24;index++) {
      const result=classifySample(pcm,48000,counts);
      assert.ok([1,3,4].includes(result.lane));
      assert.ok(result.compatibleLanes.every(lane=>[1,3,4].includes(lane)));
      counts[result.lane]++;
    }
    assert.equal(counts[0],0,'kick stays empty until a compatible sound arrives');
    assert.equal(counts[2],0,'bass stays empty until a compatible sound arrives');
    assert.equal(counts[5],0,'an unrelated percussion slot is not filled for visual completion');
  }
});

test('excluding every compatible role rejects a sound instead of routing it to an unrelated vacancy',()=>{
  for(const role of ROLE_NAMES) {
    const pcm=sound(role);
    const first=classifySample(pcm,48000);
    const excluded=classifySample(pcm,48000,[0,0,0,0,0,0],first.compatibleLanes);
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
