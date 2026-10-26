// Deterministic, physically distinct examples for classifier and raw-PCM tests.
// The quiet remainder is retained, just like a captured microphone window.
export const SAMPLE_RATE = 48000;
export const BPM = 110;
export const BEAT_SECONDS = 60 / BPM;
export const STEP_SECONDS = BEAT_SECONDS / 4;
export const LOOP_SECONDS = BEAT_SECONDS * 8;

function biquad(type, frequency, q, sampleRate) {
  const omega=2*Math.PI*frequency/sampleRate;
  const cosine=Math.cos(omega),alpha=Math.sin(omega)/(2*q),a0=1+alpha;
  const sign=type==='lowpass'?1:-1;
  const b0=(1-sign*cosine)/(2*a0),b1=sign*2*b0,b2=b0;
  const a1=-2*cosine/a0,a2=(1-alpha)/a0;
  let x1=0,x2=0,y1=0,y2=0;
  return input=>{
    const output=b0*input+b1*x1+b2*x2-a1*y1-a2*y2;
    x2=x1;x1=input;y2=y1;y1=output;
    return output;
  };
}

export function sound(kind, sampleRate = SAMPLE_RATE, seconds = 1.2) {
  let seed = 4321;
  let previousNoise = 0;
  const phoneBand=['highpass','lowpass'].flatMap(type=>[.5097956,.6013449,.8999762,2.5629154].map(q=>biquad(type,type==='highpass'?500:6000,q,sampleRate)));
  return Float32Array.from({length:Math.round(sampleRate*seconds)}, (_,index) => {
    const time = index/sampleRate;
    seed = (Math.imul(seed,1664525)+1013904223)>>>0;
    const noise = seed/4294967296*2-1;
    const highNoise = (noise-previousNoise)*.5;
    previousNoise=noise;
    const bandNoise=kind==='phone-clap'?phoneBand.reduce((value,filter)=>filter(value),noise):noise;
    const attack = Math.min(1,time/.002);
    if(kind==='kick') return attack*.65*Math.sin(2*Math.PI*75*time)*Math.exp(-time/.055);
    if(kind==='desk-thud') return attack*(.62*Math.sin(2*Math.PI*110*time)*Math.exp(-time/.065)+noise*.08*Math.exp(-time/.009));
    if(kind==='bass') return attack*.35*Math.sin(2*Math.PI*90*time)*(time<.75?1:Math.exp(-(time-.75)/.08));
    if(kind==='clap'||kind==='phone-clap') {
      const burst = Math.exp(-time/.025)+(time>=.012?Math.exp(-(time-.012)/.018)*.7:0)+(time>=.026?Math.exp(-(time-.026)/.03)*.5:0);
      return attack*(kind==='phone-clap'?bandNoise:noise)*.45*burst;
    }
    if(kind==='closed-hat'||kind==='open-hat') {
      const metal = (Math.sin(2*Math.PI*5400*time)+Math.sin(2*Math.PI*7900*time)+Math.sin(2*Math.PI*11100*time))/3;
      return attack*(metal*.46+highNoise*.06)*Math.exp(-time/(kind==='closed-hat'?.035:.27));
    }
    if(kind==='percussion') return attack*(.45*Math.sin(2*Math.PI*660*time)+.16*Math.sin(2*Math.PI*1320*time))*Math.exp(-time/.12);
    throw new Error(`Unknown sound fixture: ${kind}`);
  });
}

export const ROLE_NAMES=['kick','clap','bass','closed-hat','open-hat','percussion'];
