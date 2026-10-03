import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import { addObservation, addPoint, addSample, resolveFieldConflict, retryRecord, reviewObservation, syncQueue, verifySample, type FieldName, type RootState } from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const RISK_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' };
const FIELD_LABEL: Record<FieldName, string> = { note: '现场情况', risk: '风险等级', reviewed: '复核意见' };
function fieldValue(field: FieldName, raw: string): string {
  if (field === 'risk') return RISK_LABEL[raw] ?? raw;
  if (field === 'reviewed') return raw === 'true' ? '是' : '否';
  return raw;
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });

  const pending = state.observations.filter((item) => item.sync === 'queued' || item.sync === 'failed');
  const conflicted = state.observations.filter((item) => item.sync === 'conflict');
  const failed = state.observations.filter((item) => item.sync === 'failed');

  const recordPoint = async () => {
    try { const result = await Taro.getLocation({ type: 'gcj02' }); dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude })); } catch { dispatch(addPoint({ latitude: 30.5, longitude: 103.2 })); }
  };
  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };

  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">弱网也能记录，联网后按字段合并；同一项两边都改会挂起并列差异，不静默选边。</Text></View>
    <View className="metrics"><View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View><View><Text>待同步</Text><Text className="metric warn">{pending.length}</Text></View><View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View></View>

    <View className="card"><View className="card-title">现场记录</View><form onSubmit={handleSubmit(submit)}><Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} /><View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View><View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View><Button className="primary" formType="submit">{t.save}</Button><Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button></form></View>

    {conflicted.length > 0 && <View className="alert conflict">
      <Text className="alert-title">以下记录同一字段两边都改过，已挂起，请逐字段确认采用哪一版：</Text>
      {conflicted.map((item) => <View className="conflict-record" key={item.id}>
        <Text className="obs-title">{item.note}</Text>
        {item.conflicts.map((c) => <View className="diff" key={c.field}>
          <Text className="diff-field">{FIELD_LABEL[c.field]}</Text>
          <View className="diff-row"><Text className="diff-side">本地（离线）：{fieldValue(c.field, c.local)}</Text><Button size="mini" onClick={() => dispatch(resolveFieldConflict({ id: item.id, field: c.field, choice: 'local' }))}>采用本地</Button></View>
          <View className="diff-row"><Text className="diff-side">站里（云端）：{fieldValue(c.field, c.remote)}</Text><Button size="mini" onClick={() => dispatch(resolveFieldConflict({ id: item.id, field: c.field, choice: 'remote' }))}>采用站里</Button></View>
        </View>)}
      </View>)}
    </View>}

    <View className="card"><View className="card-title">{t.sync}<Text className="count">{pending.length} 条</Text></View>
      <Button className="secondary" onClick={() => dispatch(syncQueue())}>模拟恢复联网并同步</Button>
      {state.lastSync && <Text className="hint">上次同步 {state.lastSync.at}：成功 {state.lastSync.merged} · 冲突挂起 {state.lastSync.conflicted} · 失败留队 {state.lastSync.failed}</Text>}
      {failed.length > 0 && <View className="failed-list">{failed.map((item) => <View className="failed-row" key={item.id}><Text className="muted">{item.note} · {item.error}</Text><Button size="mini" onClick={() => dispatch(retryRecord(item.id))}>重试</Button></View>)}</View>}
      <Text className="hint">按字段合并：现场情况与风险等级以本地为准，复核意见以站里为准；同步失败不会覆盖数据，记录留在队列可重试。</Text>
    </View>

    <View className="card"><View className="card-title">观察记录</View><ScrollView scrollY className="list">{state.observations.map((item) => <View className="observation" key={item.id}><View><Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text><Text className="muted">{item.time} · {item.sync}{item.error ? ` · ${item.error}` : ''}</Text></View><Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>{item.reviewed ? '已复核' : '复核'}</Button></View>)}</ScrollView></View>

    <View className="card"><View className="card-title">轨迹与样本</View>{state.points.slice(-3).map((point) => <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source}`} />)}{state.samples.map((sample) => <View className="sample" key={sample.id}><View><Text>{sample.code} · {sample.species} × {sample.count}</Text>{sample.needsReverify && <Text className="badge-warn">需重新核验：{sample.invalidatedReason}</Text>}</View><Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>{sample.status === 'verified' ? '已核验' : '核验'}</Button></View>)}</View>
    <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后按字段合并；冲突字段挂起并列差异，失败可重试。" visible={false} />
  </View>;
}
