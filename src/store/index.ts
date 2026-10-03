import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

export type SyncState = 'local' | 'queued' | 'synced' | 'failed' | 'suspended';
export type RiskLevel = 'low' | 'medium' | 'high';
export type SampleStatus = 'draft' | 'submitted' | 'verified' | 'invalidated';
export type MergeField = 'note' | 'risk' | 'reviewNote' | 'species' | 'count';

export interface FieldConflict {
  field: MergeField;
  /** 挂起时三方数值都保留字符串，人工裁决前不丢任何一边 */
  base: string;
  local: string;
  remote: string;
}

export interface ObservationBase { note: string; risk: RiskLevel; reviewNote: string; }
export interface PatrolObservation {
  id: string;
  time: string;
  note: string;
  risk: RiskLevel;
  reviewNote: string;
  reviewed: boolean;
  sync: SyncState;
  attempts: number;
  lastError?: string;
  /** 上次成功同步时的快照，三方合并的共同祖先；离线新建记录为 null */
  base: ObservationBase | null;
  conflicts: FieldConflict[];
}

export interface TrackPoint { id: string; latitude: number; longitude: number; at: string; source: 'gps' | 'manual'; }
export interface SampleBase { species: string; count: number; }
export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  sync: SyncState;
  attempts: number;
  lastError?: string;
  base: SampleBase | null;
  conflicts: FieldConflict[];
}

export interface MergeReportEntry { id: string; fields: MergeField[]; }
export interface FailedEntry { id: string; reason: string; }
export interface SyncReport {
  at: string;
  offline: boolean;
  synced: string[];
  merged: MergeReportEntry[];
  suspended: MergeReportEntry[];
  failed: FailedEntry[];
  invalidated: string[];
}

interface State {
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  online: boolean;
  report: SyncReport | null;
}

/* ---------------------------------- 模拟站点服务 ---------------------------------- */

interface RemoteObservation { id: string; note: string; risk: RiskLevel; reviewNote: string; reviewed: boolean; }
interface RemoteSample { id: string; code: string; species: string; count: number; status: SampleStatus; }
interface MockServer { observations: RemoteObservation[]; samples: RemoteSample[]; }

const SERVER_KEY = 'yf57-mock-server';
const NETWORK_KEY = 'yf57-network-online';

const initialServer: MockServer = {
  observations: [
    { id: 'o1', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewNote: '已复核：足迹位置与红外相机记录吻合。', reviewed: true },
    { id: 'o2', note: '红外相机外壳松动，已拍照待补报', risk: 'high', reviewNote: '复核意见：请补充设备编号与安装点位，纳入设备维修台账。', reviewed: false },
    { id: 'o3', note: '样线南段无异常，已和邻组记录比对为同一观察点', risk: 'low', reviewNote: '复核意见：邻组在相邻网格提交同类观察，需现场比对后合并。', reviewed: false }
  ],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'verified' }]
};

function readServer(): MockServer {
  try {
    const saved = Taro.getStorageSync(SERVER_KEY);
    if (saved) return JSON.parse(saved) as MockServer;
  } catch { /* 存储不可用时用内置站点数据 */ }
  return initialServer;
}
function persistServer() { try { Taro.setStorageSync(SERVER_KEY, JSON.stringify(mockServer)); } catch { /* 忽略 */ } }

const mockServer: MockServer = readServer();
let online: boolean = (() => { try { return Taro.getStorageSync(NETWORK_KEY) !== false; } catch { return true; } })();

/* ---------------------------------- 三方字段合并 ---------------------------------- */

type FieldValue = string | number;

/**
 * 以 base 为共同祖先逐字段合并本地与站点版本：
 * - 只有一边相对 base 改动：直接采用改动后的版本（现场字段归巡护员，复核字段归站点）
 * - 两边都未改或改成相同值：任取其一
 * - 两边都改成不同值：该字段挂起并记录差异，由人工裁决，绝不静默选边
 */
function mergeFields<F extends MergeField>(
  local: Record<F, FieldValue>,
  remote: Record<F, FieldValue>,
  base: Record<F, FieldValue> | null,
  fields: F[]
): { merged: Record<F, FieldValue>; conflicts: FieldConflict[]; autoMerged: F[] } {
  const merged = { ...local };
  const conflicts: FieldConflict[] = [];
  const autoMerged: F[] = [];
  for (const field of fields) {
    const l = local[field];
    const r = remote[field];
    const b = base ? base[field] : undefined;
    if (l === r) { merged[field] = l; continue; }
    if (b === undefined || l === b) { merged[field] = r; if (r !== b) autoMerged.push(field); continue; }
    if (r === b) { merged[field] = l; autoMerged.push(field); continue; }
    merged[field] = l; // 挂起期间先保留本地值，差异同时完整列出
    conflicts.push({ field, base: String(b), local: String(l), remote: String(r) });
  }
  return { merged, conflicts, autoMerged };
}

/* ---------------------------------- 种子与旧数据迁移 ---------------------------------- */

const seed: State = {
  observations: [
    {
      id: 'o1', time: '2026-09-29 07:20',
      note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewNote: '已复核：足迹位置与红外相机记录吻合。',
      reviewed: true, sync: 'synced', attempts: 0,
      base: { note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewNote: '已复核：足迹位置与红外相机记录吻合。' },
      conflicts: []
    },
    {
      // 离线期间巡护员改了现场情况；同事在站里补了复核意见——两边改不同字段，应自动合并
      id: 'o2', time: '2026-09-29 08:05',
      note: '红外相机外壳松动，已临时加固并补拍设备编号照片', risk: 'high', reviewNote: '',
      reviewed: false, sync: 'queued', attempts: 0,
      base: { note: '红外相机外壳松动，已拍照待补报', risk: 'high', reviewNote: '' },
      conflicts: []
    },
    {
      // 现场情况两边都改了——同字段冲突必须挂起；风险等级巡护员刚改算新的，复核意见只站里改过，二者自动并入
      id: 'o3', time: '2026-09-29 08:40',
      note: '样线南段没有异常；巡护中发现水沟附近有零星蹄印，疑为小麂', risk: 'medium', reviewNote: '',
      reviewed: false, sync: 'queued', attempts: 0,
      base: { note: '样线南段没有异常', risk: 'low', reviewNote: '' },
      conflicts: []
    }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }
  ],
  samples: [
    { id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'verified', sync: 'synced', attempts: 0, base: { species: '疑似豹猫毛发', count: 1 }, conflicts: [] }
  ],
  online: true,
  report: null
};

function migrateObservation(raw: any): PatrolObservation {
  const fallbackBase = { note: String(raw.note ?? ''), risk: (raw.risk ?? 'low') as RiskLevel, reviewNote: String(raw.reviewNote ?? '') };
  return {
    id: raw.id,
    time: raw.time ?? '',
    note: String(raw.note ?? ''),
    risk: (raw.risk ?? 'low') as RiskLevel,
    reviewNote: String(raw.reviewNote ?? ''),
    reviewed: Boolean(raw.reviewed),
    // 旧版本的记录级 conflict 统一迁移为字段挂起态，等待新的逐字段裁决
    sync: raw.sync === 'conflict' ? 'suspended' : (raw.sync ?? 'queued'),
    attempts: Number(raw.attempts ?? 0),
    lastError: raw.lastError,
    base: raw.base ? raw.base as ObservationBase : fallbackBase,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : []
  };
}

function migrateSample(raw: any): Sample {
  return {
    id: raw.id,
    code: raw.code,
    species: String(raw.species ?? ''),
    count: Number(raw.count ?? 1),
    status: (raw.status ?? 'draft') as SampleStatus,
    sync: raw.sync === 'conflict' ? 'suspended' : (raw.sync ?? 'queued'),
    attempts: Number(raw.attempts ?? 0),
    lastError: raw.lastError,
    base: raw.base ?? null,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : []
  };
}

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        observations: (parsed.observations ?? []).map(migrateObservation),
        points: parsed.points ?? [],
        samples: (parsed.samples ?? []).map(migrateSample),
        online,
        report: null
      };
    }
  } catch { /* 存储损坏时回落到种子数据 */ }
  return { ...seed, online };
}

/* ---------------------------------- 切片 ---------------------------------- */

const OFFLINE_REASON = '当前无网络，记录保留在待同步队列，联网后可重试';

function failItem(item: { sync: SyncState; attempts: number; lastError?: string }, report: SyncReport, id: string, reason: string) {
  item.sync = 'failed';
  item.lastError = reason;
  report.failed.push({ id, reason });
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<Omit<PatrolObservation, 'id' | 'time' | 'sync' | 'reviewed' | 'reviewNote' | 'attempts' | 'base' | 'conflicts'>>) => {
      state.observations.unshift({
        id: `o-${Date.now()}`, time: new Date().toLocaleString(),
        reviewNote: '', reviewed: false, sync: 'queued', attempts: 0, base: null, conflicts: [],
        ...action.payload
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({ id: `p-${Date.now()}`, ...action.payload, at: new Date().toLocaleTimeString(), source: 'gps' });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({ id: `s-${Date.now()}`, ...action.payload, status: 'draft', sync: 'queued', attempts: 0, base: null, conflicts: [] });
    },
    setOnline: (state, action: PayloadAction<boolean>) => {
      online = action.payload;
      state.online = online;
      try { Taro.setStorageSync(NETWORK_KEY, online); } catch { /* 忽略 */ }
    },
    /** 同步待同步队列：queued / failed 的记录逐条与站点做字段级合并，挂起态等人工裁决不参与 */
    syncQueue: (state) => {
      const report: SyncReport = { at: new Date().toLocaleString(), offline: !online, synced: [], merged: [], suspended: [], failed: [], invalidated: [] };

      state.observations.forEach((item) => {
        if (item.sync !== 'queued' && item.sync !== 'failed') return;
        item.attempts += 1;
        if (!online) return failItem(item, report, item.id, OFFLINE_REASON);

        const remote = mockServer.observations.find((entry) => entry.id === item.id);
        if (!remote) {
          // 离线新建记录，站点上还没有，整记录上传
          mockServer.observations.push({ id: item.id, note: item.note, risk: item.risk, reviewNote: item.reviewNote, reviewed: item.reviewed });
          item.base = { note: item.note, risk: item.risk, reviewNote: item.reviewNote };
          item.sync = 'synced'; item.attempts = 0; item.lastError = undefined; item.conflicts = [];
          report.synced.push(item.id);
          return;
        }

        const { merged, conflicts, autoMerged } = mergeFields(
          { note: item.note, risk: item.risk, reviewNote: item.reviewNote },
          { note: remote.note, risk: remote.risk, reviewNote: remote.reviewNote },
          item.base,
          ['note', 'risk', 'reviewNote']
        );
        item.note = merged.note as string;
        item.risk = merged.risk as RiskLevel;
        item.reviewNote = merged.reviewNote as string;
        item.conflicts = conflicts;
        item.lastError = undefined;

        if (conflicts.length) {
          item.sync = 'suspended';
          report.suspended.push({ id: item.id, fields: conflicts.map((c) => c.field) });
          if (autoMerged.length) report.merged.push({ id: item.id, fields: autoMerged });
          // 站点记录原样保留，裁决结果出来后再写回
        } else {
          remote.note = item.note;
          remote.risk = item.risk;
          remote.reviewNote = item.reviewNote;
          remote.reviewed = remote.reviewed || item.reviewed;
          item.base = { note: item.note, risk: item.risk, reviewNote: item.reviewNote };
          item.sync = 'synced'; item.attempts = 0;
          if (autoMerged.length) report.merged.push({ id: item.id, fields: autoMerged });
          else report.synced.push(item.id);
        }
      });

      state.samples.forEach((item) => {
        if (item.sync !== 'queued' && item.sync !== 'failed') return;
        item.attempts += 1;
        if (!online) return failItem(item, report, item.id, OFFLINE_REASON);

        const remote = mockServer.samples.find((entry) => entry.id === item.id);
        if (!remote) {
          const status: SampleStatus = item.status === 'draft' ? 'submitted' : item.status;
          mockServer.samples.push({ id: item.id, code: item.code, species: item.species, count: item.count, status });
          item.status = status;
          item.base = { species: item.species, count: item.count };
          item.sync = 'synced'; item.attempts = 0; item.lastError = undefined; item.conflicts = [];
          report.synced.push(item.id);
          return;
        }

        const { merged, conflicts, autoMerged } = mergeFields(
          { species: item.species, count: item.count },
          { species: remote.species, count: remote.count },
          item.base,
          ['species', 'count']
        );
        item.species = merged.species as string;
        item.count = merged.count as number;
        item.conflicts = conflicts;
        item.lastError = undefined;

        if (conflicts.length) {
          item.sync = 'suspended';
          report.suspended.push({ id: item.id, fields: conflicts.map((c) => c.field) });
          if (autoMerged.length) report.merged.push({ id: item.id, fields: autoMerged });
          return;
        }

        // 核验通过后现场又改过：核验结论失效，退回待重算并同步回站点
        const nextStatus: SampleStatus = item.status === 'invalidated' ? 'submitted' : item.status;
        remote.species = item.species;
        remote.count = item.count;
        remote.status = nextStatus;
        item.status = nextStatus;
        item.base = { species: item.species, count: item.count };
        item.sync = 'synced'; item.attempts = 0;
        if (item.status === 'submitted' && autoMerged.some((f) => f === 'species' || f === 'count')) report.invalidated.push(item.id);
        if (autoMerged.length) report.merged.push({ id: item.id, fields: autoMerged });
        else report.synced.push(item.id);
      });

      state.report = report;
      persistServer();
    },
    /** 对单个挂起字段人工裁决：选用本地值或站点值；一条记录的全部字段裁决完才写回站点并解除挂起 */
    resolveFieldConflict: (state, action: PayloadAction<{ kind: 'observation' | 'sample'; id: string; field: MergeField; choice: 'local' | 'remote' }>) => {
      const { kind, id, field, choice } = action.payload;

      if (kind === 'observation') {
        const item = state.observations.find((entry) => entry.id === id);
        if (!item) return;
        const conflict = item.conflicts.find((entry) => entry.field === field);
        if (!conflict) return;
        const value = choice === 'local' ? conflict.local : conflict.remote;
        if (field === 'note') item.note = value;
        if (field === 'risk') item.risk = value as RiskLevel;
        if (field === 'reviewNote') item.reviewNote = value;
        item.conflicts = item.conflicts.filter((entry) => entry.field !== field);

        if (item.conflicts.length === 0) {
          const remote = mockServer.observations.find((entry) => entry.id === id);
          if (remote) {
            remote.note = item.note; remote.risk = item.risk; remote.reviewNote = item.reviewNote;
          } else {
            mockServer.observations.push({ id, note: item.note, risk: item.risk, reviewNote: item.reviewNote, reviewed: item.reviewed });
          }
          item.base = { note: item.note, risk: item.risk, reviewNote: item.reviewNote };
          item.sync = 'synced'; item.attempts = 0; item.lastError = undefined;
          persistServer();
        }
        return;
      }

      const item = state.samples.find((entry) => entry.id === id);
      if (!item) return;
      const conflict = item.conflicts.find((entry) => entry.field === field);
      if (!conflict) return;
      const value = choice === 'local' ? conflict.local : conflict.remote;
      if (field === 'species') item.species = value;
      if (field === 'count') item.count = Number(value) || 1;
      item.conflicts = item.conflicts.filter((entry) => entry.field !== field);

      if (item.conflicts.length === 0) {
        const remote = mockServer.samples.find((entry) => entry.id === id);
        // 裁决期间若样本核验已失效，站点也退回待重算
        const nextStatus: SampleStatus = item.status === 'invalidated' ? 'submitted' : item.status;
        if (remote) {
          remote.species = item.species; remote.count = item.count; remote.status = nextStatus;
        } else {
          mockServer.samples.push({ id, code: item.code, species: item.species, count: item.count, status: nextStatus });
        }
        item.status = nextStatus;
        item.base = { species: item.species, count: item.count };
        item.sync = 'synced'; item.attempts = 0; item.lastError = undefined;
        persistServer();
      }
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) item.reviewed = true;
    },
    /** 站点重新核验（含核验失效后的重算），结论立即作为站点版本落库 */
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.status = 'verified';
      const remote = mockServer.samples.find((entry) => entry.id === item.id);
      if (remote) {
        remote.status = 'verified'; remote.species = item.species; remote.count = item.count;
      } else {
        mockServer.samples.push({ id: item.id, code: item.code, species: item.species, count: item.count, status: 'verified' });
      }
      item.base = { species: item.species, count: item.count };
      item.sync = 'synced'; item.attempts = 0; item.lastError = undefined; item.conflicts = [];
      persistServer();
    },
    /** 样本后续改动：已核验的样本一旦改动，核验结论立即失效，记录重新进队列待同步重算 */
    amendSample: (state, action: PayloadAction<{ id: string; species?: string; count?: number }>) => {
      const item = state.samples.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      let changed = false;
      if (action.payload.species !== undefined && action.payload.species !== item.species) {
        item.species = action.payload.species;
        changed = true;
      }
      if (action.payload.count !== undefined && action.payload.count !== item.count) {
        item.count = action.payload.count;
        changed = true;
      }
      if (!changed) return;
      if (item.status === 'verified') item.status = 'invalidated';
      if (item.sync === 'synced') item.sync = 'queued';
      item.attempts = 0;
      item.lastError = undefined;
      item.conflicts = [];
    }
  }
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    connection: builder.query<{ online: boolean }, void>({
      queryFn: () => ({ data: { online: true } })
    })
  })
});
export const { useConnectionQuery } = patrolApi;
export const {
  addObservation, addPoint, addSample, amendSample, resolveFieldConflict,
  reviewObservation, setOnline, syncQueue, verifySample
} = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;

/* ---------------------------------- 展示辅助 ---------------------------------- */

export const fieldLabels: Record<MergeField, string> = {
  note: '现场情况',
  risk: '风险等级',
  reviewNote: '复核意见',
  species: '样本名称',
  count: '数量'
};
export const riskLabels: Record<RiskLevel, string> = { low: '低', medium: '中', high: '高' };
export const sampleStatusLabels: Record<SampleStatus, string> = {
  draft: '草稿',
  submitted: '已提交',
  verified: '已核验',
  invalidated: '核验失效·待重算'
};
export const syncLabels: Record<SyncState, string> = {
  local: '本地',
  queued: '待同步',
  synced: '已同步',
  failed: '同步失败·待重试',
  suspended: '字段挂起'
};
export function displayFieldValue(field: MergeField, value: string): string {
  if (field === 'risk') return riskLabels[value as RiskLevel] ?? value;
  return value || '（空）';
}
