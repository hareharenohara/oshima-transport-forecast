"""Reload the research model and check prediction/aggregation consistency."""
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from train_ai_evidence_model import Encoder, SOURCE, OUT, GROUPS
from retrain_model_127 import sigmoid, average_precision

def main():
    model=json.loads((OUT/'model.json').read_text(encoding='utf-8'))
    metadata=json.loads((OUT/'metadata.json').read_text(encoding='utf-8'))
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==metadata['source_sha256']
    frame=pd.read_csv(SOURCE,encoding='utf-8-sig')
    frame['service_date']=pd.to_datetime(frame.service_date).dt.strftime('%Y-%m-%d')
    # Restore parameters without fitting on any evaluation rows.
    from train_model_v2_offline import V2HybridFeatureBuilder
    enc=Encoder(); enc.base=V2HybridFeatureBuilder()
    enc.numeric=model['numeric_bins']; enc.categories=model['category_levels']
    x=enc.transform(frame)
    assert x.shape[1]==len(model['coef'])==len(model['feature_names'])
    assert not any(any(s in n for s in ['target_', 'operation_status', 'reason_', 'actual_oshima_port', 'snapshot_']) for n in model['feature_names'])
    c=model['calibrator']; p=sigmoid(c['a']*(x@np.asarray(model['coef'])+model['intercept'])+c['b'])
    saved=pd.read_csv(OUT/'predictions.csv',encoding='utf-8-sig').set_index('voyage_id')
    assert saved.index.is_unique and len(saved)==len(frame)
    expected=saved.loc[frame.voyage_id].probability.to_numpy()
    error=float(np.max(np.abs(p-expected)))
    assert error<1e-12
    for split in ['train','calibration','validation','test']:
        rows=saved[saved.split==split]
        assert len(rows)==metadata['split_summary'][split]['rows']
        assert abs(average_precision(rows.actual,rows.probability)-metadata['split_summary'][split]['metrics']['pr_auc'])<1e-12
    profiles=pd.read_csv(OUT/'value_profiles.csv',encoding='utf-8-sig')
    for (split,feature),part in profiles[profiles.scope=='all'].groupby(['split','feature']):
        assert part.rows.sum()==metadata['split_summary'][split]['rows']
        assert part.cancellations.sum()==metadata['split_summary'][split]['cancellations']
    # Missing, exact boundary, and unseen-category inputs produce finite results.
    probe=frame.iloc[:1].copy()
    col=next(iter(enc.numeric)); probe[col]=np.nan; probe['counterpart_terminal']='unknown'
    assert np.isfinite(enc.transform(probe)).all()
    cuts=enc.numeric[col]
    if cuts:
        probe[col]=cuts[0]
        assert enc.transform(probe)[0,0]==1
    result={'reloaded_prediction_max_error':error,'profiles_reconcile':True,'no_outcome_fields':True,
            'missing_and_boundary_checks':True,'feature_columns':x.shape[1],'rows':len(frame)}
    (OUT/'verification.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    # A bounded view of the exploratory range relationships, without rule adoption.
    relationships=[]
    for (item,feature,scope),part in profiles[~profiles.missing].groupby(['item','feature','scope']):
        periods={}
        for split in ['validation','test']:
            bins=part[(part.split==split)&part.sufficient].sort_values('bin')
            if len(bins)>=2:
                low,high=bins.iloc[0],bins.iloc[-1]
                periods[split]={'lowest_supported_bin':int(low.bin),'highest_supported_bin':int(high.bin),
                    'lowest_bin_cancellation_rate':float(low.observed_cancellation_rate),
                    'highest_bin_cancellation_rate':float(high.observed_cancellation_rate),
                    'difference':float(high.observed_cancellation_rate-low.observed_cancellation_rate)}
        if len(periods)==2:
            same_bins=all(periods['validation'][k]==periods['test'][k] for k in ['lowest_supported_bin','highest_supported_bin'])
            diff=[periods[s]['difference'] for s in ['validation','test']]
            trend=('高い範囲で欠航実績が多い' if min(diff)>0 else '低い範囲で欠航実績が多い' if max(diff)<0 else '期間で関係が変わる') if same_bins else '比較できる範囲が期間で異なる'
            relationships.append({'item':item,'feature':feature,'scope':scope,'observed_relationship':trend,
                'periods':periods,'status':'association_only_review_required'})
    (OUT/'relationship_summary.json').write_text(json.dumps(relationships,ensure_ascii=False,indent=2),encoding='utf-8')
    # Companion notebook: compact evidence viewer, leaves training to the script.
    cells=[{'cell_type':'markdown','metadata':{},'source':['# AI判断材料用MLの確認\n','モデルは研究用です。再学習は scripts/train_ai_evidence_model.py、再現検証は scripts/verify_ai_evidence_model.py。\n','値の区切りは学習データの四分位であり、安全基準ではありません。']},
           {'cell_type':'code','metadata':{},'execution_count':None,'outputs':[],
            'source':['import json\nfrom pathlib import Path\nimport pandas as pd\n',
                      "root = Path.cwd()\nwhile not (root / 'artifacts/ai_evidence_model/metadata.json').exists():\n    if root.parent == root:\n        raise RuntimeError('Open from the project directory')\n    root = root.parent\n",
                      "out = root / 'artifacts/ai_evidence_model'\nmetadata = json.loads((out / 'metadata.json').read_text(encoding='utf-8'))\npd.DataFrame(metadata['split_summary']).T\n"]},
           {'cell_type':'code','metadata':{},'execution_count':None,'outputs':[],
            'source':["items = json.loads((out / 'item_evidence.json').read_text(encoding='utf-8'))\n",
                      "pd.DataFrame([{'項目':r['label'], '評価':r['assessment'], '検証差':r['periods']['validation']['pr_auc_gain'], '確認差':r['periods']['test']['pr_auc_gain']} for r in items])\n"]},
           {'cell_type':'code','metadata':{},'execution_count':None,'outputs':[],
            'source':["profiles = pd.read_csv(out / 'value_profiles.csv')\nprofiles[(profiles.feature == 'journey_wind_gusts_10m_max') & (profiles.scope == 'all')]\n"]},
           {'cell_type':'markdown','metadata':{},'source':['## 解釈の制限\n','確認期間の性能低下と区間の不確実性があり、AI判断ルールへの採用は未承認です。船種・航路の混在、日をまたぐ荒天、相関、実測と未来予報の違いが残ります。']}]
    notebook={'cells':cells,'metadata':{'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'},'language_info':{'name':'python','version':'3'}},'nbformat':4,'nbformat_minor':5}
    for i,cell in enumerate(cells):cell['id']=f'evidence-{i}'
    (OUT/'review.ipynb').write_text(json.dumps(notebook,ensure_ascii=False,indent=2),encoding='utf-8')
    # Run the companion cell code in order as Python; Jupyter is not installed here.
    namespace={}
    for cell in cells:
        if cell['cell_type']=='code':exec(''.join(cell['source']),namespace)
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
