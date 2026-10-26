export const ROLE_NAMES = Object.freeze(['kick', 'clap', 'bass', 'closed-hat', 'open-hat', 'percussion']);

function fft(real, imaginary) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let span = 2; span <= size; span <<= 1) {
    const angle = -2 * Math.PI / span;
    const stepReal = Math.cos(angle), stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += span) {
      let wr = 1, wi = 0;
      for (let offset = 0; offset < span / 2; offset++) {
        const a = start + offset, b = a + span / 2;
        const tr = wr * real[b] - wi * imaginary[b];
        const ti = wr * imaginary[b] + wi * real[b];
        real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
        real[a] += tr; imaginary[a] += ti;
        const nextReal = wr * stepReal - wi * stepImaginary;
        wi = wr * stepImaginary + wi * stepReal; wr = nextReal;
      }
    }
  }
}

// Analysis uses its own arrays. The captured recording is never rewritten.
export function analyzeSample(pcm, sampleRate) {
  const rate = sampleRate > 0 ? sampleRate : 48000;
  const frameLength = Math.max(1, Math.round(rate * 0.01));
  const envelope = [];
  let mean = 0, peak = 0;
  for (const value of pcm) mean += value;
  mean /= Math.max(1, pcm.length);
  for (let start = 0; start < pcm.length; start += frameLength) {
    let square = 0;
    const end = Math.min(pcm.length, start + frameLength);
    for (let i = start; i < end; i++) {
      const value = pcm[i] - mean;
      square += value * value; peak = Math.max(peak, Math.abs(value));
    }
    envelope.push(Math.sqrt(square / Math.max(1, end - start)));
  }
  const largestRms = Math.max(0, ...envelope);
  const audible = Math.max(0.00001, largestRms * 0.12);
  let first = envelope.findIndex(value => value >= audible);
  if (first < 0) first = 0;
  let last = envelope.length - 1;
  while (last > first && envelope[last] < audible) last--;
  const start = first * frameLength;
  const end = Math.max(start, Math.min(pcm.length, (last + 1) * frameLength));
  const activeLength = Math.max(1, end - start);
  let energy = 0, sustainedEnergy = 0, tailEnergy = 0, crossings = 0;
  let peakFrame = first;
  for (let i = first; i <= last; i++) if (envelope[i] > (envelope[peakFrame] || 0)) peakFrame = i;
  for (let i = start; i < end; i++) {
    const value = pcm[i] - mean;
    energy += value * value;
    if (i - start >= rate * 0.08) sustainedEnergy += value * value;
    if (i - start >= activeLength * 0.66) tailEnergy += value * value;
    if (i > start && value * (pcm[i - 1] - mean) < 0) crossings++;
  }

  // Three Hann-windowed spectra cover the attack and body, excluding the long
  // quiet capture tail. 12 kHz keeps ultrasonic microphone noise out of roles.
  const size = 2048;
  const spectrum = new Float64Array(size / 2 + 1);
  const windowPitches = [];
  const positions = [...new Set([start, Math.max(start, peakFrame * frameLength - size / 4), start + Math.max(0, activeLength - size) * 0.5].map(Math.floor))];
  for (const position of positions) {
    const real = new Float64Array(size), imaginary = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const sample = position + i;
      real[i] = sample < end ? (pcm[sample] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1))) : 0;
    }
    fft(real, imaginary);
    const powerAt = bin => real[bin] ** 2 + imaginary[bin] ** 2;
    let strongestBin = 0, strongestPower = 0;
    for (let bin = 1; bin < spectrum.length; bin++) {
      const power = powerAt(bin);
      spectrum[bin] += power;
      if (bin * rate / size <= 12000 && power > strongestPower) { strongestPower = power; strongestBin = bin; }
    }
    if (strongestBin > 1 && strongestBin < spectrum.length - 1) {
      const a = Math.log(Math.max(powerAt(strongestBin-1),1e-16));
      const b = Math.log(Math.max(strongestPower,1e-16));
      const c = Math.log(Math.max(powerAt(strongestBin+1),1e-16));
      const denominator = a-2*b+c;
      const offset = Math.abs(denominator)>1e-12 ? Math.max(-0.5,Math.min(0.5,0.5*(a-c)/denominator)) : 0;
      windowPitches.push((strongestBin+offset)*rate/size);
    }
  }
  let total = 0, weighted = 0, logs = 0, bins = 0, strongest = 0, dominantHz = 0, dominantBin = 0;
  let low = 0, lowMid = 0, mid = 0, high = 0, air = 0;
  const ceiling = Math.min(12000, rate / 2);
  for (let bin = 1; bin < spectrum.length; bin++) {
    const frequency = bin * rate / size;
    if (frequency > ceiling) break;
    const power = spectrum[bin];
    total += power; weighted += power * frequency;
    logs += Math.log(Math.max(power, 1e-16)); bins++;
    if (power > strongest) { strongest = power; dominantHz = frequency; dominantBin = bin; }
    if (frequency < 300) low += power;
    else if (frequency < 1000) lowMid += power;
    else if (frequency < 3000) mid += power;
    else if (frequency < 7000) high += power;
    else air += power;
  }
  const divisor = Math.max(total, 1e-16);
  if (dominantBin > 1 && dominantBin < spectrum.length - 1) {
    const a = Math.log(Math.max(spectrum[dominantBin - 1], 1e-16));
    const b = Math.log(Math.max(spectrum[dominantBin], 1e-16));
    const c = Math.log(Math.max(spectrum[dominantBin + 1], 1e-16));
    const denominator = a - 2*b + c;
    const offset = Math.abs(denominator) > 1e-12 ? Math.max(-0.5,Math.min(0.5,0.5*(a-c)/denominator)) : 0;
    dominantHz = (dominantBin + offset) * rate / size;
  }
  let entropy = 0;
  for (let bin = 1; bin <= bins; bin++) {
    const probability = spectrum[bin] / divisor;
    if (probability > 0) entropy -= probability * Math.log(probability);
  }
  return {
    lowRatio:low/divisor, lowMidRatio:lowMid/divisor, midRatio:mid/divisor,
    highRatio:(high+air)/divisor, airRatio:air/divisor,
    centroid:total > 1e-16 ? weighted/total : 0,
    flatness:total > 1e-16 ? Math.min(1, Math.exp(logs/Math.max(1,bins))/(total/Math.max(1,bins))) : 0,
    spectralEntropy:entropy / Math.log(Math.max(2,bins)),
    dominantHz,
    pitchSpreadCents:windowPitches.length > 1 ? 1200*Math.log2(Math.max(...windowPitches)/Math.min(...windowPitches)) : 0,
    zeroCrossingRate:crossings/activeLength,
    activeDuration:(end-start)/rate, attackSeconds:Math.max(0,peakFrame-first)*frameLength/rate,
    sustainRatio:sustainedEnergy/Math.max(energy,1e-16), tailRatio:tailEnergy/Math.max(energy,1e-16),
    peak, rms:Math.sqrt(energy/activeLength),
  };
}

export function classifySample(pcm, sampleRate, occupiedCounts = [0,0,0,0,0,0], excludedLanes = []) {
  const features = analyzeSample(pcm, sampleRate);
  const f = features;
  let category, candidates, confidence;
  if (f.lowRatio >= 0.52 || (f.lowRatio >= 0.32 && f.centroid < 700)) {
    const sustained = f.activeDuration >= 0.28 && f.sustainRatio > 0.38;
    category = sustained ? 'low-resonance' : 'low-impact';
    candidates = sustained ? [[2,1],[0,0.77]] : [[0,1],[2,0.77]];
    confidence = Math.min(0.97, 0.66 + f.lowRatio * 0.3);
  } else if (f.highRatio > 0.80 && f.centroid > 4700 && f.lowRatio + f.lowMidRatio < 0.12) {
    const ringing = f.activeDuration > 0.22 && f.sustainRatio > 0.24;
    category = ringing ? 'bright-ring' : 'bright-tick';
    candidates = ringing ? [[4,1],[3,0.82]] : [[3,1],[4,0.78]];
    confidence = Math.min(0.96, 0.65 + f.highRatio * 0.28);
  } else if ((f.flatness > 0.09 || f.spectralEntropy > 0.65) && f.attackSeconds < 0.09 && f.centroid > 900) {
    category = 'broadband-clap';
    candidates = [[1,1],[3,0.74]];
    if (f.activeDuration > 0.20) candidates.push([4,0.69]);
    confidence = Math.min(0.94, 0.65 + f.flatness * 0.35);
  } else {
    category = 'mid-resonance';
    candidates = [[5,1]];
    // A short, noisy mid-band tap can reasonably take the clap role too.
    if (f.flatness > 0.035 && f.activeDuration < 0.30 && f.attackSeconds < 0.07) candidates.push([1,0.68]);
    confidence = f.flatness < 0.05 && f.centroid > 300 && f.centroid < 4500 ? 0.82 : 0.58;
  }
  const compatibleLanes = candidates.map(([lane]) => lane);
  const available = candidates.filter(([lane]) => !excludedLanes.includes(lane));
  const vacant = available.filter(([lane]) => !occupiedCounts[lane]);
  const options = vacant.length ? vacant : available;
  const selected = options.reduce((best, item) => !best || item[1] - (occupiedCounts[item[0]] || 0)*0.04 > best[1] - (occupiedCounts[best[0]] || 0)*0.04 ? item : best, null);
  const lane = selected?.[0] ?? null;
  return {lane,role:lane === null ? null : ROLE_NAMES[lane],category,confidence:confidence*(selected?.[1] || 0),features,compatibleLanes};
}
