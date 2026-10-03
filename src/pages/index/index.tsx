import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addPoint, addSample, amendSample, displayFieldValue, fieldLabels,
  resolveFieldConflict, reviewObservation, riskLabels, sampleStatusLabels, setOnline,
  syncLabels, syncQueue, verifySample, type MergeField, type RootState
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });
  const pendingObs = state.observations.filter((item) => item.sync === 'queued' || item.sync === 'failed');
  const pendingSamples = state.samples.filter((item) => item.sync === 'queued' || item.sync === 'failed');
  const queued = pendingObs.length + pendingSamples.length;
  const suspended = state.observations.filter((item) => item.sync === 'suspended').length
    + state.samples.filter((item) => item.sync === 'suspended').length;

  const recordPoint = async () => {
    try { const result = await Taro.getLocation({ type: 'gcj02' }); dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude })); } catch { dispatch(addPoint({ latitude: 30.5, longitude: 103.2 })); }
  };
  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };
  // 演示“后续改动”：在已核验样本上补记数量，核验结论应立即失效并进队列
  const amendSampleCount = (id: string, code: string, count: number) => {
    Taro.showModal({
      title: `样本 ${code} 后续改动`,
      content: `现场补记后样本数量将更新为 ${count + 1}。若该样本已核验，原核验结论会立即失效，同步后由站点重新核验。`,
      confirmText: '确认补记',
      success: (res) => { if (res.confirm) dispatch(amendSample({ id, count: count + 1 })); }
    });
  };
  const report = state.report;

  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">弱网也能记录，联网后按字段合并；同字段两边都改会挂起列差异，不静默覆盖任何一方。</Text></View>
    <View className="metrics"><View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View><View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View><View><Text>字段挂起</Text><Text className="metric danger">{suspended}</Text></View></View>

    <View className="card">
      <View className="card-title">现场记录</View>
      <form onSubmit={handleSubmit(submit)}>
        <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
        <View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View>
        <View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View>
        <Button className="primary" formType="submit">{t.save}</Button>
        <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
      </form>
    </View>

    <View className="card">
      <View className="card-title">{t.sync}<Text className="count">{queued} 条待处理</Text></View>
      <View className="net-row">
        <Button size="mini" className={state.online ? 'net-on' : 'net-off'} onClick={() => dispatch(setOnline(!state.online))}>
          {state.online ? '● 当前在线（点击模拟断网）' : '○ 当前无信号（点击恢复联网）'}
        </Button>
      </View>
      <Button className="secondary" disabled={queued === 0} onClick={() => dispatch(syncQueue())}>
        {state.online ? '立即同步待同步队列' : '离线尝试同步（失败记录保留，可重试）'}
      </Button>
      <Text className="hint">自动合并规则：本地新写的现场情况、风险等级采用本地版本；站里的复核意见、样本核验结论继续保留；同一项两边都改过则挂起并列出三方差异。</Text>
    </View>

    {report && <View className="card report">
      <View className="card-title">同步结果<Text className="muted">{report.at}</Text></View>
      {report.offline && <Text className="report-line fail">无网络：{report.failed.length} 条记录保留在待同步队列，恢复联网后点同步即可重试。</Text>}
      {!report.offline && report.synced.length > 0 && <Text className="report-line ok">直接同步：{report.synced.join('、')}</Text>}
      {report.merged.map((entry) => <Text className="report-line ok" key={`m-${entry.id}`}>{entry.id} 按字段自动并入：{entry.fields.map((f) => fieldLabels[f]).join('、')}</Text>)}
      {report.suspended.map((entry) => <Text className="report-line warn" key={`s-${entry.id}`}>{entry.id} 挂起（两边都改）：{entry.fields.map((f) => fieldLabels[f]).join('、')}，请在下方逐条裁决</Text>)}
      {report.invalidated.length > 0 && <Text className="report-line warn">样本核验失效待重算：{report.invalidated.join('、')}</Text>}
      {!report.offline && report.failed.map((entry) => <Text className="report-line fail" key={`f-${entry.id}`}>{entry.id} 同步失败：{entry.reason}</Text>)}
      {!report.offline && report.synced.length === 0 && report.merged.length === 0 && report.suspended.length === 0 && report.invalidated.length === 0 && report.failed.length === 0 && <Text className="hint">队列中没有待同步记录。</Text>}
    </View>}

    <View className="card">
      <View className="card-title">观察记录</View>
      <ScrollView scrollY className="list">
        {state.observations.map((item) => <View className="observation-block" key={item.id}>
          <View className="observation">
            <View>
              <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
              <Text className="muted">{item.time} · {syncLabels[item.sync]}{item.attempts > 0 ? ` · 已尝试 ${item.attempts} 次` : ''}</Text>
              <Text className="muted">风险：{riskLabels[item.risk]}{item.reviewed ? ' · 已复核' : ''}</Text>
              {item.reviewNote ? <Text className="review-note">站里复核：{item.reviewNote}</Text> : <Text className="muted">站里复核：（暂无意见）</Text>}
              {item.sync === 'failed' && item.lastError && <Text className="error-note">失败原因：{item.lastError}</Text>}
            </View>
            <Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button>
          </View>
          {item.conflicts.map((conflict) => <View className="diff" key={conflict.field}>
            <Text className="diff-title">「{fieldLabels[conflict.field as MergeField]}」两边都改过，已挂起</Text>
            <Text className="diff-base">同步前：{displayFieldValue(conflict.field as MergeField, conflict.base)}</Text>
            <Text className="diff-local">本地（巡护员离线修改）：{displayFieldValue(conflict.field as MergeField, conflict.local)}</Text>
            <Text className="diff-remote">站点（同事修改）：{displayFieldValue(conflict.field as MergeField, conflict.remote)}</Text>
            <View className="alert-actions">
              <Button size="mini" onClick={() => dispatch(resolveFieldConflict({ kind: 'observation', id: item.id, field: conflict.field as MergeField, choice: 'local' }))}>采用本地值</Button>
              <Button size="mini" onClick={() => dispatch(resolveFieldConflict({ kind: 'observation', id: item.id, field: conflict.field as MergeField, choice: 'remote' }))}>采用站点值</Button>
            </View>
          </View>)}
        </View>)}
      </ScrollView>
    </View>

    <View className="card">
      <View className="card-title">轨迹与样本</View>
      {state.points.slice(-3).map((point) => <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source}`} />)}
      {state.samples.map((sample) => <View className="sample-block" key={sample.id}>
        <View className="sample">
          <Text>{sample.code} · {sample.species} × {sample.count} · {sampleStatusLabels[sample.status]}{sample.sync !== 'synced' ? ` · ${syncLabels[sample.sync]}` : ''}</Text>
          <View className="sample-actions">
            <Button size="mini" onClick={() => amendSampleCount(sample.id, sample.code, sample.count)}>后续改动</Button>
            <Button size="mini" disabled={sample.status === 'verified' || sample.status === 'draft'} onClick={() => dispatch(verifySample(sample.id))}>
              {sample.status === 'verified' ? '已核验' : sample.status === 'invalidated' ? '重新核验' : '核验'}
            </Button>
          </View>
        </View>
        {sample.status === 'invalidated' && <Text className="error-note">该样本核验后发生改动，原核验结论已失效；同步后由站点重新核验（重算）。</Text>}
        {sample.sync === 'failed' && sample.lastError && <Text className="error-note">失败原因：{sample.lastError}</Text>}
        {sample.conflicts.map((conflict) => <View className="diff" key={conflict.field}>
          <Text className="diff-title">「{fieldLabels[conflict.field as MergeField]}」两边都改过，已挂起</Text>
          <Text className="diff-base">同步前：{displayFieldValue(conflict.field as MergeField, conflict.base)}</Text>
          <Text className="diff-local">本地：{displayFieldValue(conflict.field as MergeField, conflict.local)}</Text>
          <Text className="diff-remote">站点：{displayFieldValue(conflict.field as MergeField, conflict.remote)}</Text>
          <View className="alert-actions">
            <Button size="mini" onClick={() => dispatch(resolveFieldConflict({ kind: 'sample', id: sample.id, field: conflict.field as MergeField, choice: 'local' }))}>采用本地值</Button>
            <Button size="mini" onClick={() => dispatch(resolveFieldConflict({ kind: 'sample', id: sample.id, field: conflict.field as MergeField, choice: 'remote' }))}>采用站点值</Button>
          </View>
        </View>)}
      </View>)}
    </View>
    <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后按字段合并；同字段两边都改会挂起等待人工裁决。" visible={false} />
  </View>;
}
