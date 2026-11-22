export type Vec3 = [number, number, number];
export type Severity = "error" | "warning" | "info";
export type MoveKind = "rapid" | "feed" | "arc" | "dwell" | "toolchange" | "stop";
export type OpKind = "position" | "mill" | "drill" | "tap" | "bore" | "reference" | "none";
export type BlockStatus = "executed" | "skipped" | "halted" | "not_run" | "after_end";
export type VerifyStatus = "ok" | "warnings" | "errors" | "halted";

export interface Move {
  kind: MoveKind;
  op: OpKind;
  block: number;
  line: number;
  start: Vec3;
  end: Vec3;
  duration: number;
  length: number;
  feed: number | null;
  tool: number | null;
  spindle: number;
  coolant: boolean;
  points?: Vec3[];
  note?: string;
}

export interface BlockRow {
  index: number;
  line: number;
  text: string;
  status: BlockStatus;
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  line: number | null;
  block: number | null;
  halt: boolean;
}

export interface ToolRow {
  tool: number | null;
  first_line: number | null;
  cut_length: number;
  cut_time: number;
  operations: string[];
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface Summary {
  status: VerifyStatus;
  halted_at_block: number | null;
  halted_at_line: number | null;
  verification_complete: boolean;
  limitations: string[];
  blocks_total: number;
  blocks_executed: number;
  move_count: number;
  rapid_count: number;
  linear_count: number;
  arc_count: number;
  rapid_distance: number;
  cutting_distance: number;
  time_rapid: number;
  time_cutting: number;
  time_dwell: number;
  time_toolchange: number;
  time_total: number;
  tool_changes: number;
  tools: ToolRow[];
  holes: Record<string, number>;
  bounds_all: Bounds | null;
  bounds_cutting: Bounds | null;
  errors: number;
  warnings: number;
  infos: number;
  final_units: string;
  stock?: StockStats;
}

export type ToolType = "flat" | "ball" | "bull" | "face" | "drill" | "spot" | "reamer" | "tap" | "counterbore";

export interface ToolInfo {
  key: string;
  number: number | null;
  type: ToolType | string;
  diameter: number;
  corner_radius: number;
  point_angle: number;
  source: "default" | "comment" | "user" | string;
  description: string;
}

export interface ToolOverride {
  type: ToolType;
  diameter: number;
  corner_radius: number;
}

export interface StockGrid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cx: number;
  cy: number;
  top: number;
  bottom: number;
}

export interface StockStats {
  grid: StockGrid;
  material: string;
  initial_volume: number;
  final_volume: number;
  removed_volume: number;
  removed_by_tool: { tool: number | null; volume: number }[];
  time_in_material: number;
  time_air_cutting: number;
  air_cutting_percent: number;
  rapid_in_stock_moves: number;
  lowest_point: number;
}

export interface InterpretResponse {
  program: { id: number; filename: string };
  blocks: BlockRow[];
  moves: Move[];
  diagnostics: Diagnostic[];
  summary: Summary;
  tools: ToolInfo[];
  stock: StockStats;
}

export interface ProgramMeta {
  id: number;
  filename: string;
  controller: string;
  size_bytes: number;
  line_count: number;
  uploaded_at: string;
  last_status: VerifyStatus | null;
}

export const WCS = ["G54", "G55", "G56", "G57", "G58", "G59"] as const;

/** Settings sent to the backend interpreter. */
export interface InterpreterSetup {
  controller: string;
  initial_units: "mm" | "inch";
  work_offsets: Record<string, Vec3>;
  reference_position: Vec3;
  rapid_rate: number;
  max_feed: number;
  tool_change_time: number;
  decimal_mode: "calculator" | "least_increment";
  rapid_mode: "linear" | "dogleg";
  block_delete_switch: boolean;
  cutter_comp_mode: "tool_radius" | "zero";
}

export type StockOrigin =
  | "top-center"
  | "top-front-left"
  | "top-front-right"
  | "top-back-left"
  | "top-back-right";

/** Display-only job/stock setup (stock removal arrives in Phase 2). */
export interface StockSetup {
  size: Vec3;
  origin: StockOrigin;
  topZ: number;
  material: string;
  allowance: number;
}

export const defaultInterpreterSetup = (): InterpreterSetup => ({
  controller: "fanuc",
  initial_units: "mm",
  work_offsets: Object.fromEntries(WCS.map((c) => [c, [0, 0, 0] as Vec3])),
  reference_position: [0, 0, 100],
  rapid_rate: 15000,
  max_feed: 10000,
  tool_change_time: 6,
  decimal_mode: "calculator",
  rapid_mode: "linear",
  block_delete_switch: false,
  cutter_comp_mode: "tool_radius",
});

export const defaultStock = (): StockSetup => ({
  size: [200, 150, 40],
  origin: "top-center",
  topZ: 0,
  material: "P20 mould steel",
  allowance: 0,
});
