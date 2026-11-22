/** FANUC milling dialect. Port of backend app/gcode/controllers/{base,fanuc}.py. */

export type Support = "supported" | "no_effect" | "limited" | "unsupported";

export interface CodeSpec {
  code: string;
  group: string;
  description: string;
  support: Support;
  note: string;
}

export interface ControllerDialect {
  key: string;
  name: string;
  codes: Map<string, CodeSpec>;
  letters: Record<string, string>;
  foreignAxes: Set<string>;
  peckClearanceMm: number;
}

const S: Support = "supported";
const N: Support = "no_effect";
const L: Support = "limited";
const U: Support = "unsupported";

type Row = [string, string, string, Support, string?];

const G: Row[] = [
  ["G0", "motion", "Rapid positioning", S],
  ["G1", "motion", "Linear interpolation", S],
  ["G2", "motion", "Circular interpolation CW", S],
  ["G3", "motion", "Circular interpolation CCW", S],
  ["G4", "nonmodal", "Dwell", S],
  ["G5", "lookahead", "High-speed machining (P10000 = AI contour control on, P0 = off)", S, "Only P10000 / P0 are accepted; other P values run high-speed cycle data that is not simulated."],
  ["G5.1", "lookahead", "AI contour control", N],
  ["G8", "lookahead", "Look-ahead control", N],
  ["G9", "nonmodal", "Exact stop (one block)", N],
  ["G10", "nonmodal", "Programmable data input", U, "Changes offsets or parameters at run time."],
  ["G15", "polar", "Polar coordinates cancel", N],
  ["G16", "polar", "Polar coordinates", U],
  ["G17", "plane", "XY plane", S],
  ["G18", "plane", "ZX plane", S],
  ["G19", "plane", "YZ plane", S],
  ["G20", "units", "Inch input", S],
  ["G21", "units", "Metric input", S],
  ["G27", "nonmodal", "Reference position check", U],
  ["G28", "nonmodal", "Return to reference position", L, "Reference position is assumed until a machine is configured."],
  ["G29", "nonmodal", "Return from reference position", U],
  ["G30", "nonmodal", "Return to 2nd/3rd/4th reference", U, "Needs machine configuration."],
  ["G31", "nonmodal", "Skip function (probing)", U],
  ["G40", "cutter_comp", "Cutter compensation cancel", S],
  ["G41", "cutter_comp", "Cutter compensation left", L, "Programmed path shown, not the offset cutter centre."],
  ["G42", "cutter_comp", "Cutter compensation right", L, "Programmed path shown, not the offset cutter centre."],
  ["G43", "length_comp", "Tool length compensation +", S, "Tool tip is assumed to follow the programmed point."],
  ["G44", "length_comp", "Tool length compensation -", U],
  ["G49", "length_comp", "Tool length compensation cancel", S],
  ["G50", "scaling", "Scaling cancel", N],
  ["G51", "scaling", "Scaling", U],
  ["G50.1", "mirror", "Programmable mirror image cancel", N],
  ["G51.1", "mirror", "Programmable mirror image", U],
  ["G52", "nonmodal", "Local coordinate system", S],
  ["G53", "nonmodal", "Machine coordinate positioning", L, "Machine coordinates are assumed until a machine is configured."],
  ["G54", "wcs", "Work coordinate system 1", S],
  ["G55", "wcs", "Work coordinate system 2", S],
  ["G56", "wcs", "Work coordinate system 3", S],
  ["G57", "wcs", "Work coordinate system 4", S],
  ["G58", "wcs", "Work coordinate system 5", S],
  ["G59", "wcs", "Work coordinate system 6", S],
  ["G54.1", "wcs", "Additional work coordinate systems", U],
  ["G61", "cutting_mode", "Exact stop mode", N],
  ["G62", "cutting_mode", "Automatic corner override", N],
  ["G63", "cutting_mode", "Tapping mode", N],
  ["G64", "cutting_mode", "Cutting mode", N],
  ["G65", "nonmodal", "Macro call", U],
  ["G66", "macro_modal", "Macro modal call", U],
  ["G67", "macro_modal", "Macro modal call cancel", N],
  ["G68", "rotation", "Coordinate system rotation", U],
  ["G69", "rotation", "Coordinate system rotation cancel", N],
  ["G73", "cycle", "High-speed peck drilling cycle", S],
  ["G74", "cycle", "Left-hand tapping cycle", S],
  ["G76", "cycle", "Fine boring cycle", L, "Tool shift at the bottom (Q) is not simulated."],
  ["G80", "cycle", "Canned cycle cancel", S],
  ["G81", "cycle", "Drilling cycle", S],
  ["G82", "cycle", "Drilling cycle with dwell (counterbore)", S],
  ["G83", "cycle", "Peck drilling cycle", S],
  ["G84", "cycle", "Tapping cycle", S],
  ["G85", "cycle", "Boring cycle (feed out)", S],
  ["G86", "cycle", "Boring cycle (spindle stop, rapid out)", S],
  ["G87", "cycle", "Back boring cycle", U],
  ["G88", "cycle", "Boring cycle (dwell, manual retract)", L, "Manual retract is simulated as a rapid to the return level."],
  ["G89", "cycle", "Boring cycle with dwell (feed out)", S],
  ["G90", "distance", "Absolute programming", S],
  ["G91", "distance", "Incremental programming", S],
  ["G92", "nonmodal", "Coordinate system setting", S],
  ["G93", "feed_mode", "Inverse time feed", U],
  ["G94", "feed_mode", "Feed per minute", S],
  ["G95", "feed_mode", "Feed per revolution", S],
  ["G98", "cycle_return", "Canned cycle return to initial level", S],
  ["G99", "cycle_return", "Canned cycle return to R level", S],
];

const M: Row[] = [
  ["M0", "stop", "Program stop", S],
  ["M1", "stop", "Optional stop", S],
  ["M2", "stop", "Program end", S],
  ["M30", "stop", "Program end and rewind", S],
  ["M3", "spindle", "Spindle on CW", S],
  ["M4", "spindle", "Spindle on CCW", S],
  ["M5", "spindle", "Spindle stop", S],
  ["M6", "toolchange", "Tool change", S],
  ["M7", "coolant", "Mist coolant on", S],
  ["M8", "coolant", "Flood coolant on", S],
  ["M9", "coolant", "Coolant off", S],
  ["M19", "spindle_orient", "Spindle orientation", N],
  ["M29", "rigid_tap", "Rigid tapping mode", S],
  ["M98", "subprogram", "Subprogram call", U, "Subprograms are not expanded yet."],
  ["M99", "subprogram", "Subprogram end / return", U, "Subprograms are not expanded yet."],
];

export function buildFanuc(): ControllerDialect {
  const codes = new Map<string, CodeSpec>();
  for (const [code, group, description, support, note] of [...G, ...M]) codes.set(code, { code, group, description, support, note: note ?? "" });
  return {
    key: "fanuc",
    name: "FANUC (0i / 30i series, milling)",
    codes,
    letters: {
      G: "Preparatory function",
      M: "Miscellaneous function",
      X: "X axis",
      Y: "Y axis",
      Z: "Z axis",
      I: "Arc centre X offset",
      J: "Arc centre Y offset",
      K: "Arc centre Z offset / cycle repeat count",
      R: "Arc radius / cycle R level",
      F: "Feed rate",
      S: "Spindle speed",
      T: "Tool number",
      H: "Tool length offset number",
      D: "Cutter radius offset number",
      P: "Dwell time / parameter",
      Q: "Peck depth / shift amount",
      L: "Repeat count",
    },
    foreignAxes: new Set(["A", "B", "C", "U", "V", "W"]),
    peckClearanceMm: 0.5,
  };
}

export function getDialect(key: string): ControllerDialect {
  if (key === "fanuc") return buildFanuc();
  throw new Error(`Unknown controller '${key}'. Available: fanuc`);
}
