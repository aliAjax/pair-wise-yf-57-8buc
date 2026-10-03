import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

export type SyncState = 'queued' | 'synced' | 'conflict' | 'failed';
export type Risk = 'low' | 'medium' | 'high';
export type FieldName = 'note' | 'risk' | 'reviewed';

/** 同一字段两边都改过：挂起，列出差异，不静默选边 */
export interface FieldConflict { field: FieldName; local: string; remote: string; }

export interface PatrolObservation {
  id: string;
  time: string;
  note: string;
  risk: Risk;
  reviewed: boolean;
  sync: SyncState;
  /** 上次同步成功时的快照，用于判断字段是否被改过 */
  base: { note: string; risk: Risk; reviewed: boolean } | null;
  /** 挂起的字段级冲突 */
  conflicts: FieldConflict[];
  /** 同步失败原因，失败后留在待同步队列可重试 */
  error?: string;
}

export interface TrackPoint { id: string; latitude: number; longitude: number; at: string; source: 'gps' | 'manual'; }

export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: 'draft' | 'submitted' | 'verified';
  /** 核验依据快照，后续改动导致失效时用于比对 */
  verifiedSnapshot?: { code: string; species: string; count: number };
  /** 已核验但遇到后续改动，需失效重算 */
  needsReverify?: boolean;
  invalidatedReason?: string;
}

interface LastSync { merged: number; conflicted: number; failed: number; at: string; }
interface State { observations: PatrolObservation[]; points: TrackPoint[]; samples: Sample[]; lastSync: LastSync | null; }

/** 弱网下每条记录同步失败的概率（模拟），失败后记录留在待同步队列 */
const FAIL_RATE = 0.25;
const EMPTY_BASE = { note: '', risk: 'low' as Risk, reviewed: false };

const seed: State = {
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, conflicts: [], base: { note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewed: false } },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, conflicts: [], base: { note: '红外相机外壳松动', risk: 'medium', reviewed: false } },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, conflicts: [], base: { note: '样线南段没有异常', risk: 'low', reviewed: true } }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }
  ],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }],
  lastSync: null
};

function readState(): State {
  try { const saved = Taro.getStorageSync('yf57-patrol-state'); return saved ? JSON.parse(saved) as State : seed; } catch { return seed; }
}

/** 模拟服务端返回的记录：站里会复核中高风险记录，偶尔也会直接改现场记录 */
function simulateRemote(item: PatrolObservation) {
  const base = item.base ?? EMPTY_BASE;
  const isInsert = item.base === null;
  // 站里优先复核中高风险记录（复核意见只来自站里）
  const reviewed: boolean = item.risk !== 'low' ? true : base.reviewed;
  // 站里电话跟进后可能直接改记录；新记录插入前站里没有旧版本，不算编辑
  const note: string = !isInsert && item.risk === 'high' ? `${base.note}（站里已电话跟进核实）` : base.note;
  return { note, risk: base.risk, reviewed };
}

/**
 * 字段级合并（直接修改 draft）：
 * - 本地改过、站里没改 → 留本地（现场情况/风险等级以本地为准）
 * - 站里改过、本地没改 → 留站里（复核意见以站里为准）
 * - 两边都改同一字段 → 挂起该字段，列出差异，不静默选边
 * 返回 'merged' | 'conflicted'
 */
function mergeOne(item: PatrolObservation): 'merged' | 'conflicted' {
  const base = item.base ?? EMPTY_BASE;
  const remote = simulateRemote(item);
  const conflicts: FieldConflict[] = [];

  const localNote = item.note !== base.note;
  const remoteNote = remote.note !== base.note;
  const localRisk = item.risk !== base.risk;
  const remoteRisk = remote.risk !== base.risk;
  const localReviewed = item.reviewed !== base.reviewed;
  const remoteReviewed = remote.reviewed !== base.reviewed;

  if (localNote && remoteNote) conflicts.push({ field: 'note', local: item.note, remote: remote.note });
  else if (remoteNote) item.note = remote.note;

  if (localRisk && remoteRisk) conflicts.push({ field: 'risk', local: item.risk, remote: remote.risk });
  else if (remoteRisk) item.risk = remote.risk;

  if (localReviewed && remoteReviewed) conflicts.push({ field: 'reviewed', local: String(item.reviewed), remote: String(remote.reviewed) });
  else if (remoteReviewed) item.reviewed = remote.reviewed;

  item.error = undefined;
  if (conflicts.length) {
    item.sync = 'conflict';
    item.conflicts = conflicts;
    return 'conflicted';
  }
  item.sync = 'synced';
  item.conflicts = [];
  item.base = { note: item.note, risk: item.risk, reviewed: item.reviewed };
  return 'merged';
}

const slice = createSlice({
  name: 'patrol', initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<Omit<PatrolObservation, 'id' | 'time' | 'sync' | 'reviewed' | 'conflicts' | 'base'>>) => {
      const now = new Date();
      state.observations.unshift({
        id: `o-${now.getTime()}`,
        time: now.toLocaleString(),
        ...action.payload,
        sync: 'queued',
        reviewed: false,
        conflicts: [],
        // 新记录对服务端来说是插入：没有旧快照，首次同步成功后再写入 base
        base: null
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({ id: `p-${Date.now()}`, ...action.payload, at: new Date().toLocaleTimeString(), source: 'gps' });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      state.samples.unshift({ id: `s-${Date.now()}`, ...action.payload, status: 'draft' });
      // 后续改动：同一物种有了新的现场记录，已核验样本的依据过期，失效重算
      for (const s of state.samples) {
        if (s.status === 'verified' && s.species === action.payload.species) {
          s.status = 'submitted';
          s.verifiedSnapshot = undefined;
          s.needsReverify = true;
          s.invalidatedReason = '同一物种有新的现场记录提交，原核验依据已过期，需重新核验';
        }
      }
    },
    /** 同步待同步队列（含上次失败仍留在队列的记录） */
    syncQueue: (state) => {
      const targets = state.observations.filter((item) => item.sync === 'queued' || item.sync === 'failed');
      let merged = 0, conflicted = 0, failed = 0;
      for (const item of targets) {
        if (Math.random() < FAIL_RATE) {
          item.sync = 'failed';
          item.error = '弱网环境下连接中断，记录仍保留在待同步队列，可重试';
          failed++;
          continue;
        }
        if (mergeOne(item) === 'conflicted') conflicted++; else merged++;
      }
      state.lastSync = { merged, conflicted, failed, at: new Date().toLocaleTimeString() };
    },
    /** 单条重试：失败后记录仍在待同步队列，可再次同步 */
    retryRecord: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (!item || (item.sync !== 'queued' && item.sync !== 'failed')) return;
      if (Math.random() < FAIL_RATE) {
        item.sync = 'failed';
        item.error = '弱网环境下连接中断，记录仍保留在待同步队列，可重试';
        return;
      }
      mergeOne(item);
    },
    /** 字段级冲突：按字段选择本地或站里，全部字段解决后记录才同步完成 */
    resolveFieldConflict: (state, action: PayloadAction<{ id: string; field: FieldName; choice: 'local' | 'remote' }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const idx = item.conflicts.findIndex((entry) => entry.field === action.payload.field);
      if (idx < 0) return;
      const raw = action.payload.choice === 'local' ? item.conflicts[idx].local : item.conflicts[idx].remote;
      if (action.payload.field === 'note') item.note = raw;
      else if (action.payload.field === 'risk') item.risk = raw as Risk;
      else item.reviewed = raw === 'true';
      item.conflicts.splice(idx, 1);
      if (item.conflicts.length === 0) {
        item.sync = 'synced';
        item.error = undefined;
        item.base = { note: item.note, risk: item.risk, reviewed: item.reviewed };
      }
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) item.reviewed = true;
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.status = 'verified';
      item.needsReverify = false;
      item.invalidatedReason = undefined;
      item.verifiedSnapshot = { code: item.code, species: item.species, count: item.count };
    },
    /** 已核验样本遇到后续改动（更正物种/数量），失效重算 */
    updateSample: (state, action: PayloadAction<{ id: string; species?: string; count?: number }>) => {
      const item = state.samples.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const speciesChanged = action.payload.species !== undefined && action.payload.species !== item.species;
      const countChanged = action.payload.count !== undefined && action.payload.count !== item.count;
      if (item.status === 'verified' && (speciesChanged || countChanged)) {
        item.status = 'submitted';
        item.verifiedSnapshot = undefined;
        item.needsReverify = true;
        item.invalidatedReason = '核验后样本信息被更正，原核验失效，需重新核验';
      }
      if (action.payload.species !== undefined) item.species = action.payload.species;
      if (action.payload.count !== undefined) item.count = action.payload.count;
    }
  }
});

export const patrolApi = createApi({ reducerPath: 'patrolApi', baseQuery: fakeBaseQuery(), endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) }) });
export const { useConnectionQuery } = patrolApi;
export const { addObservation, addPoint, addSample, resolveFieldConflict, retryRecord, reviewObservation, syncQueue, updateSample, verifySample } = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;
