// The first recording is the steady pulse: four quarter notes in every bar.
export const DEFAULT_BPM = 110;
export const FIRST_PULSE_STEPS = Object.freeze([0, 4, 8, 12, 16, 20, 24, 28]);
export const PLACEMENT_SECONDS = 0.3;

// Start with an immediately readable beat. Recordings provide the variation.
export const STARTER_GROOVE = Object.freeze({
  name: 'steady-four',
  family: 'straight',
  swing: 0,
  lanes: Object.freeze([
    FIRST_PULSE_STEPS,
    Object.freeze([4, 12, 20, 28]),
    Object.freeze([0, 16]),
    Object.freeze([2, 10, 18, 26]),
    Object.freeze([14, 30]),
    Object.freeze([6, 22]),
  ]),
});

export const GROOVE_PRESETS = Object.freeze([STARTER_GROOVE]);
