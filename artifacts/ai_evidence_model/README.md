# AI判断材料用MLの試作

既存の就航予測モデルとは独立した、項目の有用性を検討するためのオフラインモデルです。AIへの組み込みはしていません。

## 今回の結論

専用モデルと分析出力は作成しましたが、この試作からAI用の判断基準を確定できません。PR-AUCは検証期間0.7463に対し確認期間0.5404となり、期間をまたぐ汎化性能に課題があります。事前に定めた「両期間の差0.005以上・日単位区間の下限が正」の条件を満たした項目はありませんでした。

突風・波周期などは両期間で追加有用性の候補となりましたが、その区間にはゼロが含まれます。波高などの期間差は、情報が不要という結論ではなく、このモデルで安定して学習できていない可能性を含みます。AI入力を削除する根拠として単独利用しません。

## 方法

学習期間だけで数値の四分位境界を決定し、値の範囲別効果を持つ加算型ロジスティックモデルを学習しました。日ごとの合計重みを均等化し、欠航・非欠航の学習重みを調整しています。2025Q4で校正し、2026年1〜5月で正則化を選択、6月以降を確認期間としています。結果判明後の情報は入力に使っていません。ただし気象自体は実測・再解析です。

各項目に属する全特徴量を取り除いて再学習し、追加の予測有用性を評価しました。差の区間は日単位200回ブートストラップです。

|項目|検証PR-AUC差|確認PR-AUC差|評価|
|---|---:|---:|---|
|風速|0.0046|-0.0046|期間依存・未確定|
|突風|0.0160|0.0164|有用性の候補・未確定|
|風向|-0.0053|-0.0119|有用性の候補・未確定|
|波高|0.1273|-0.0367|期間依存・未確定|
|波周期|0.0107|0.0082|有用性の候補・未確定|
|波向|-0.0069|0.0064|期間依存・未確定|
|風浪高さ|-0.0001|-0.0062|有用性の候補・未確定|
|風浪周期|0.0036|-0.0058|期間依存・未確定|
|風浪方向|0.0061|-0.0244|期間依存・未確定|
|うねり高さ|0.0057|0.0047|有用性の候補・未確定|
|うねり周期|-0.0138|-0.0513|有用性の候補・未確定|
|うねり方向|-0.0074|-0.0004|有用性の候補・未確定|
|気圧|-0.0133|0.0139|期間依存・未確定|
|降水量|-0.0099|0.0170|期間依存・未確定|
|雲量|0.0060|0.0079|有用性の候補・未確定|

差は「全項目モデル − 項目を除いたモデル」。他の相関項目で代替できれば差が小さくなるため、ゼロや負の差はその情報が運航上不要という意味ではありません。

## 値との関係・適用条件

value_profiles.csvには、学習時に固定した値の範囲ごとに、検証・確認期間、船種・相手港別の便数・日数・欠航数・実績欠航率を保存しています。これは未調整の実績関係であり、他条件の影響を除いた因果関係ではありません。model_terms.csvは他の入力項目を含む加算モデル上の範囲別効果です。方向はsin/cosで扱い、単一成分の大小を方位の危険度とは解釈しません。

segment_evidence.csvには船種・航路別の追加有用性を保存しています。100便・欠航10便・20日未満の区分では性能差を採用せず、値の範囲別実績は30便・10日未満を不足と表示します。これらは分析上の表示基準で、運航基準ではありません。

## 評価と採用の境界

「安定した有用性を確認」は両期間でPR-AUC差0.005以上、かつ各日単位95%区間の下限が正の場合。他の分類も暫定的な分析要約です。値の境界は四分位であり、欠航閾値には使いません。全項目のAI採用状態はreview_requiredです。

## 制約

- Historical reanalysis, not forecasts available before departure
- Test period was previously examined in this project; not a new untouched test
- Associations and model effects are not causes or official cancellation thresholds
- Bootstrap is clustered by date, not by multi-day weather event; intervals are unadjusted for multiple comparisons
- Additive model does not fit explicit interactions; ranges are train quartiles, not safety thresholds
- Sparse segments cannot support route-specific adoption; no AI input integration

## 成果物

- model.json: 専用モデル
- item_evidence.json: 項目評価・期間別差・不確実性
- value_profiles.csv: 値と実績の関係
- segment_evidence.csv: 船種・航路別有用性
- model_terms.csv: 範囲別モデル効果
- metadata.json: データ品質・期間・性能・出典ハッシュ
- predictions.csv: 再現確認用の予測
- relationship_summary.json: 値の範囲と実績の関係の要約（因果・閾値ではありません）
- verification.json: 保存モデルの予測再現と集計整合の確認結果
- review.ipynb: 結果を確認するノートブック。セルのPythonコードは順に実行済みですが、Jupyter・nbformatが未導入のためカーネル実行・ビューア表示は未検証です。検証する場合はプロジェクト内で `python -m jupyter nbconvert --execute --to notebook --inplace artifacts/ai_evidence_model/review.ipynb` を実行してください。

再現: scripts/train_ai_evidence_model.py。既存モデル・Worker・AIプロンプトは変更しません。
