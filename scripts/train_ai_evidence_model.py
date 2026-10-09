"""Train an offline, interpretable model for reviewing AI input evidence.

Writes only artifacts/ai_evidence_model; never modifies the active model.
"""
from __future__ import annotations

import os
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from retrain_model_127 import average_precision, sigmoid, PlattCalibrator
from train_model_v2_offline import V2HybridFeatureBuilder

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'ai_evidence_model'
SOURCE = ROOT / 'data' / '04_ml_dataset_training_eligible_v2_points.csv'
SEED = 20261007
GROUPS = {
    'wind_speed': ('風速', 'm/s'), 'gusts': ('突風', 'm/s'),
    'wind_direction': ('風向', 'sin/cos'), 'wave_height': ('波高', 'm'),
    'wave_period': ('波周期', 's'), 'wave_direction': ('波向', 'sin/cos'),
    'wind_wave_height': ('風浪高さ', 'm'), 'wind_wave_period': ('風浪周期', 's'),
    'wind_wave_direction': ('風浪方向', 'sin/cos'),
    'swell_height': ('うねり高さ', 'm'), 'swell_period': ('うねり周期', 's'),
    'swell_direction': ('うねり方向', 'sin/cos'),
    'pressure': ('気圧', 'hPa'), 'precipitation': ('降水量', 'mm'), 'cloud': ('雲量', '%'),
}

def group_of(name):
    for fragment, group in [('swell_wave_height','swell_height'), ('swell_wave_period','swell_period'),
        ('swell_wave_direction','swell_direction'), ('wind_wave_height','wind_wave_height'),
        ('wind_wave_period','wind_wave_period'), ('wind_wave_direction','wind_wave_direction'),
        ('wind_gusts','gusts'), ('wind_direction','wind_direction'), ('wind_speed','wind_speed'),
        ('pressure_msl','pressure'), ('precipitation','precipitation'), ('cloud_cover','cloud'),
        ('wave_height','wave_height'), ('wave_period','wave_period'), ('wave_direction','wave_direction')]:
        if fragment in name:
            return group
    if 'hours_' in name and 'wind_ge' in name:
        return 'wind_speed'
    if 'hours_' in name and 'wave_ge' in name:
        return 'wave_height'
    return 'context'

class Encoder:
    """Train-only quartile bins, explicit missing bin, schedule/route controls."""
    def fit(self, frame):
        self.base = V2HybridFeatureBuilder()
        work = self.base._base_frame(frame)
        columns = [c for c in work if c.startswith(('journey_', 'pre3h_', 'pre6h_', 'change_', 'hours_route_'))
                   and 'peak_period' not in c and 'circular_mean_deg' not in c]
        columns += [f'point__{p}__{s}' for p in self.base.FIXED_POINTS for s in self.base.SUFFIXES]
        columns += [f'role__counterpart_terminal__{s}' for s in self.base.SUFFIXES]
        columns += ['estimated_duration_minutes','departure_month_sin','departure_month_cos',
                    'departure_hour_sin','departure_hour_cos','departure_weekend']
        self.numeric, self.categories, self.names, self.groups, self.descriptors = {}, {}, [], [], []
        for col in columns:
            v = pd.to_numeric(work[col], errors='coerce').replace([np.inf,-np.inf],np.nan)
            cuts = np.unique(v.dropna().quantile([.25,.5,.75]).to_numpy()).tolist() if v.notna().any() else []
            self.numeric[col] = cuts
            for b in range(len(cuts)+2):
                self.names.append(f'{col}:bin{b}')
                self.groups.append(group_of(col))
                self.descriptors.append({'feature':col, 'bin':b, 'missing':b==len(cuts)+1})
        for col in ['ship_type','direction','counterpart_terminal','voyage_number']:
            self.categories[col] = sorted(work[col].fillna('__MISSING__').astype(str).unique().tolist())
            for level in self.categories[col]:
                self.names.append(f'{col}={level}'); self.groups.append('context')
                self.descriptors.append({'feature':col,'level':level})
        return self

    def transform(self, frame):
        work = self.base._base_frame(frame)
        arrays = []
        for col,cuts in self.numeric.items():
            v = pd.to_numeric(work[col],errors='coerce').to_numpy(float)
            codes = np.searchsorted(cuts,v,side='left')
            codes[~np.isfinite(v)] = len(cuts)+1
            arrays.append((codes[:,None] == np.arange(len(cuts)+2)).astype(float))
        for col,levels in self.categories.items():
            values = work[col].fillna('__MISSING__').astype(str).to_numpy()
            arrays.append((values[:,None] == np.asarray(levels)).astype(float))
        return np.hstack(arrays)

def fit(x,y,dates,l2,epochs=450):
    # Equal total weight per date, then balance target classes.
    counts = pd.Series(dates).map(pd.Series(dates).value_counts()).to_numpy(float)
    weights = 1/counts
    weights[y==1] *= weights[y==0].sum()/weights[y==1].sum()
    w = np.zeros(x.shape[1]); b = 0.; m = w.copy(); v = w.copy(); mb=vb=0.
    for epoch in range(1,epochs+1):
        err = (sigmoid(x@w+b)-y)*weights
        grad = x.T@err/weights.sum()+l2*w
        gb = err.sum()/weights.sum()
        m=.9*m+.1*grad; v=.999*v+.001*grad*grad
        mb=.9*mb+.1*gb; vb=.999*vb+.001*gb*gb
        w -= .03*(m/(1-.9**epoch))/(np.sqrt(v/(1-.999**epoch))+1e-8)
        b -= .03*(mb/(1-.9**epoch))/(np.sqrt(vb/(1-.999**epoch))+1e-8)
    return w,float(b)

def train_predict(xs,ys,frames,columns,l2):
    w,b = fit(xs['train'][:,columns],ys['train'],frames['train'].service_date,l2)
    cal = PlattCalibrator().fit(xs['calibration'][:,columns]@w+b,ys['calibration'])
    return w,b,cal,{s:cal.predict(x[:,columns]@w+b) for s,x in xs.items()}

def metrics(y,p):
    return {'pr_auc':average_precision(y,p),'brier':float(np.mean((p-y)**2))}

def day_bootstrap(y,full,removed,dates,seed):
    rng=np.random.default_rng(seed); unique=np.unique(dates)
    positions=[np.flatnonzero(dates==day) for day in unique]
    deltas=[]
    for _ in range(200):
        ix=np.concatenate([positions[j] for j in rng.integers(0,len(unique),len(unique))])
        if y[ix].sum():
            deltas.append(average_precision(y[ix],full[ix])-average_precision(y[ix],removed[ix]))
    return [float(v) for v in np.quantile(deltas,[.025,.975])]

def main():
    frame=pd.read_csv(SOURCE,encoding='utf-8-sig')
    frame['service_date']=pd.to_datetime(frame.service_date,errors='raise').dt.strftime('%Y-%m-%d')
    assert frame.voyage_id.is_unique and frame.service_date.notna().all()
    assert set(frame.target_weather_cancelled.unique()) == {0,1}
    assert pd.to_numeric(frame.ml_eligible).eq(1).all()
    masks={'train':frame.service_date <= '2025-09-30',
           'calibration':frame.service_date.between('2025-10-01','2025-12-31'),
           'validation':frame.service_date.between('2026-01-01','2026-05-31'),
           'test':frame.service_date >= '2026-06-01'}
    assert sum(m.astype(int) for m in masks.values()).eq(1).all()
    frames={s:frame.loc[m].copy() for s,m in masks.items()}
    encoder=Encoder().fit(frames['train'])
    xs={s:encoder.transform(f) for s,f in frames.items()}
    ys={s:f.target_weather_cancelled.to_numpy(int) for s,f in frames.items()}
    assert all(np.isfinite(x).all() for x in xs.values())
    groups=np.asarray(encoder.groups); allcols=np.arange(len(groups))
    candidates=[]
    for l2 in [.005,.02,.1]:
        w,b,cal,p=train_predict(xs,ys,frames,allcols,l2)
        candidates.append((average_precision(ys['validation'],p['validation']),l2,w,b,cal,p))
        print('candidate',l2,metrics(ys['validation'],p['validation']),flush=True)
    _,l2,w,b,cal,p=max(candidates,key=lambda t:t[0])
    records=[]; segment_rows=[]
    for gi,(group,(label,unit)) in enumerate(GROUPS.items()):
        cols=np.flatnonzero(groups!=group)
        _,_,_,removed=train_predict(xs,ys,frames,cols,l2)
        record={'item':group,'label':label,'unit':unit,'feature_count':int((groups==group).sum()),'periods':{}}
        for s in ['validation','test']:
            delta=average_precision(ys[s],p[s])-average_precision(ys[s],removed[s])
            ci=day_bootstrap(ys[s],p[s],removed[s],frames[s].service_date.to_numpy(),SEED+gi)
            record['periods'][s]={'pr_auc_gain':delta,'day_bootstrap_95_interval':ci,
                'brier_gain':float(np.mean((removed[s]-ys[s])**2)-np.mean((p[s]-ys[s])**2))}
            for keys,ix in frames[s].groupby(['ship_type','counterpart_terminal']).indices.items():
                y=ys[s][ix]; days=frames[s].iloc[ix].service_date.nunique()
                sufficient=len(ix)>=100 and y.sum()>=10 and days>=20
                segment_rows.append({'item':group,'split':s,'ship_type':keys[0],'terminal':keys[1],
                    'rows':len(ix),'cancellations':int(y.sum()),'days':days,'sufficient':sufficient,
                    'pr_auc_gain':average_precision(y,p[s][ix])-average_precision(y,removed[s][ix]) if sufficient else None})
        gains=[record['periods'][s]['pr_auc_gain'] for s in ['validation','test']]
        lows=[record['periods'][s]['day_bootstrap_95_interval'][0] for s in ['validation','test']]
        if min(lows)>0 and min(gains)>=.005:
            rating='安定した有用性を確認'
        elif gains[0]*gains[1]<0:
            rating='期間依存・未確定'
        elif max(abs(g) for g in gains)<.005:
            rating='追加の有用性は小さい・未確定'
        else:
            rating='有用性の候補・未確定'
        record['assessment']=rating
        record['ai_use_status']='review_required'
        records.append(record)
        print(label,rating,[round(g,4) for g in gains],flush=True)

    # Train-defined ranges only. Outcomes here are observed associations, not causal effects.
    profiles=[]
    representatives={}
    for col in encoder.numeric:
        if col.startswith('journey_') and (col.endswith('_max') or col.endswith('_sin_mean') or col.endswith('_cos_mean')):
            g=group_of(col)
            if g in GROUPS:
                representatives[col]=g
    for col,g in representatives.items():
        cuts=encoder.numeric[col]
        for s in ['validation','test']:
            f=frames[s]; vals=pd.to_numeric(f[col],errors='coerce').to_numpy(float)
            bins=np.searchsorted(cuts,vals,side='left'); bins[~np.isfinite(vals)]=len(cuts)+1
            scopes=[('all',np.arange(len(f)))]
            scopes += [(f'{ship}/{terminal}',ix) for (ship,terminal),ix in f.groupby(['ship_type','counterpart_terminal']).indices.items()]
            for scope,ix in scopes:
                for k in range(len(cuts)+2):
                    selected=ix[bins[ix]==k]
                    if not len(selected): continue
                    n=len(selected); days=int(f.iloc[selected].service_date.nunique()); cancels=int(ys[s][selected].sum())
                    lo=None if k==0 or k==len(cuts)+1 else cuts[k-1]
                    hi=cuts[k] if k<len(cuts) else None
                    profiles.append({'item':g,'feature':col,'split':s,'scope':scope,'bin':k,
                        'lower_exclusive':lo,'upper_inclusive':hi,'missing':k==len(cuts)+1,
                        'rows':n,'days':days,'cancellations':cancels,'observed_cancellation_rate':cancels/n,
                        'mean_model_prediction':float(p[s][selected].mean()),'sufficient':n>=30 and days>=10})

    OUT.mkdir(parents=True,exist_ok=True)
    metadata={'status':'offline_research_not_for_production','purpose':'AI input item evidence, not operational rules',
        'source':str(SOURCE.relative_to(ROOT)),'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'seed':SEED,'selected_l2':l2,'model_type':'day_weighted_binned_additive_logistic',
        'split_summary':{s:{'rows':len(f),'days':int(f.service_date.nunique()),'cancellations':int(ys[s].sum()),
                          'start':f.service_date.min(),'end':f.service_date.max(),'metrics':metrics(ys[s],p[s])} for s,f in frames.items()},
        'quality':{'duplicate_voyage_ids':0,'numeric_missing_rates':{c:float(frame[c].isna().mean()) for c in encoder.numeric if c in frame}},
        'limitations':['Historical reanalysis, not forecasts available before departure',
            'Test period was previously examined in this project; not a new untouched test',
            'Associations and model effects are not causes or official cancellation thresholds',
            'Bootstrap is clustered by date, not by multi-day weather event; intervals are unadjusted for multiple comparisons',
            'Additive model does not fit explicit interactions; ranges are train quartiles, not safety thresholds',
            'Sparse segments cannot support route-specific adoption; no AI input integration']}
    model={'schema_version':'ai-evidence-binned-1','status':metadata['status'],
        'numeric_bins':encoder.numeric,'category_levels':encoder.categories,'feature_names':encoder.names,
        'feature_groups':encoder.groups,'coef':w.tolist(),'intercept':b,'calibrator':cal.to_dict(),
        'unknown_category_policy':'all_zero','numeric_missing_policy':'explicit_bin'}
    (OUT/'model.json').write_text(json.dumps(model,ensure_ascii=False,indent=2),encoding='utf-8')
    (OUT/'metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    (OUT/'item_evidence.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    pd.DataFrame(segment_rows).to_csv(OUT/'segment_evidence.csv',index=False,encoding='utf-8-sig')
    pd.DataFrame(profiles).to_csv(OUT/'value_profiles.csv',index=False,encoding='utf-8-sig')
    pd.DataFrame([dict(d,coefficient=float(v),calibrated_logit_contribution=float(cal.a*v)) for d,v in zip(encoder.descriptors,w)]).to_csv(OUT/'model_terms.csv',index=False,encoding='utf-8-sig')
    predictions=pd.concat([pd.DataFrame({'voyage_id':f.voyage_id,'service_date':f.service_date,'split':s,'actual':ys[s],'probability':p[s]}) for s,f in frames.items()])
    predictions.to_csv(OUT/'predictions.csv',index=False,encoding='utf-8-sig')
    report=['# AI判断材料用MLの試作','', '既存の就航予測モデルとは独立した、項目の有用性を検討するためのオフラインモデルです。AIへの組み込みはしていません。','',
        '## 方法','', '学習期間だけで数値の四分位境界を決定し、値の範囲別効果を持つ加算型ロジスティックモデルを学習しました。日ごとの合計重みを均等化し、欠航・非欠航の学習重みを調整しています。2025Q4で校正し、2026年1〜5月で正則化を選択、6月以降を確認期間としています。結果判明後の情報は入力に使っていません。ただし気象自体は実測・再解析です。','',
        '各項目に属する全特徴量を取り除いて再学習し、追加の予測有用性を評価しました。差の区間は日単位200回ブートストラップです。','',
        '|項目|検証PR-AUC差|確認PR-AUC差|評価|','|---|---:|---:|---|']
    for r in records:
        report.append(f"|{r['label']}|{r['periods']['validation']['pr_auc_gain']:.4f}|{r['periods']['test']['pr_auc_gain']:.4f}|{r['assessment']}|")
    report += ['', '差は「全項目モデル − 項目を除いたモデル」。他の相関項目で代替できれば差が小さくなるため、ゼロや負の差はその情報が運航上不要という意味ではありません。', '',
        '## 値との関係・適用条件','',
        'value_profiles.csvには、学習時に固定した値の範囲ごとに、検証・確認期間、船種・相手港別の便数・日数・欠航数・実績欠航率を保存しています。これは未調整の実績関係であり、他条件の影響を除いた因果関係ではありません。model_terms.csvは他の入力項目を含む加算モデル上の範囲別効果です。方向はsin/cosで扱い、単一成分の大小を方位の危険度とは解釈しません。', '',
        'segment_evidence.csvには船種・航路別の追加有用性を保存しています。100便・欠航10便・20日未満の区分では性能差を採用せず、値の範囲別実績は30便・10日未満を不足と表示します。これらは分析上の表示基準で、運航基準ではありません。', '',
        '## 評価と採用の境界','',
        '「安定した有用性を確認」は両期間でPR-AUC差0.005以上、かつ各日単位95%区間の下限が正の場合。他の分類も暫定的な分析要約です。値の境界は四分位であり、欠航閾値には使いません。全項目のAI採用状態はreview_requiredです。', '',
        '## 制約',''] + ['- '+v for v in metadata['limitations']] + ['',
        '## 成果物','', '- model.json: 専用モデル','- item_evidence.json: 項目評価・期間別差・不確実性',
        '- value_profiles.csv: 値と実績の関係','- segment_evidence.csv: 船種・航路別有用性','- model_terms.csv: 範囲別モデル効果',
        '- metadata.json: データ品質・期間・性能・出典ハッシュ','- predictions.csv: 再現確認用の予測','',
        '再現: scripts/train_ai_evidence_model.py。既存モデル・Worker・AIプロンプトは変更しません。']
    (OUT/'README.md').write_text('\n'.join(report)+'\n',encoding='utf-8')
    print(json.dumps(metadata['split_summary'],ensure_ascii=False),flush=True)

if __name__=='__main__':
    main()
