# 学習モデル入力項目 精査レポート

## 判定

**Needs revision before production（本番前に追加対応が必要）**。モデル入力の計算定義は再現可能になったが、実績再解析と未来予報のモデル差、地点を一括集計している構造、推定所要時間の根拠が本番精度の主要リスクである。

## 131項目を精査した結果

- 元モデル: 131入力（数値81、カテゴリone-hot 50）
- 修正版: **127入力**（数値77、カテゴリone-hot 50）
- 削除: 風向、波向、風浪向、うねり向の `circular_mean_deg` 4項目
- 修正: 便番号を `1100.0` 形式から `1100` 形式へ統一
- 修正: 出航前3/6時間窓から出航後の丸め時間を除外し、推定到着後の時間も除外

修正後モデルは再学習・再評価済み。最終テストはRecall 92.3%、Precision 32.3%、誤警報率21.5%、PR-AUC 0.698。

## 地点の意味

気象海象77入力は、**地点別の列ではない**。便の対岸港に応じて3～7地点を選び、その全地点・全対象時刻をまとめて平均・最大・最小等へ圧縮している。

東京:tokyo_port,tokyo_bay_mouth,uraga_channel,sagami_north,sagami_central,oshima_north_okata,oshima_west_motomachi; 横浜:tokyo_bay_mouth,uraga_channel,sagami_north,sagami_central,oshima_north_okata,oshima_west_motomachi; 久里浜:uraga_channel,sagami_north,sagami_central,oshima_north_okata,oshima_west_motomachi; 熱海:atami_offshore,sagami_north,sagami_central,oshima_north_okata,oshima_west_motomachi; 伊東:ito_offshore,sagami_central,oshima_north_okata,oshima_west_motomachi; 稲取:inatori_offshore,sagami_central,oshima_north_okata,oshima_west_motomachi; 館山:tateyama_offshore,sagami_central,oshima_north_okata,oshima_west_motomachi

したがって現在のモデルは「相模灘中央が悪い」「岡田港沖が悪い」と地点別に説明できない。港予測や局所的な欠航原因説明には、地点別特徴量を追加した次期モデルが必要。

## 時間帯と加工

- `journey_*`: 出航時刻を含む時間格子から推定到着時刻以前まで。全地点・全時刻の平均/最大/最小。
- `pre3h_*`: 出航3時間前以上、出航時刻以前の整数時刻。平均/最大/最小。
- `pre6h_*`: 出航6時間前以上、出航時刻以前の整数時刻。平均/最大/最小。
- `change_3h/6h_*`: 出航時刻を切り下げた時刻の航路地点平均から3/6時間前の平均を引く。
- `hours_route_*`: 出航6時間前～推定到着時刻で、航路上のどこかが風速10m/sまたは波高2.5m以上となる時刻数。
- 方向: 角度平均ではなくsin/cos平均。北をまたぐ359度と1度を正しく扱う。

## 未来予報から再現できるか

2026-09-28時点の実APIリクエストで、11地点・5日先について、モデルが使う気象6変数と海象9変数の全てで値が返ることを確認した。JST、風速m/s指定も確認済み。

ただし、**列を作れることと、学習時と同じ意味・分布になることは別**。学習値はERA5およびOpen-Meteo Marine Historical、未来値は予報モデルであり、予報誤差とモデルバイアスがある。過去予報アーカイブまたは擬似運用で分布差・確率校正を検証するまでは、本番確率として扱わないこと。

## 主な問題と対応

1. **[P1] 地点別情報を失っている**: 全地点を一括集計しており、東京湾口・相模灘・岡田港沖等を区別できない。次期モデルでは重要地点ごとの最大値・平均値、港側特徴量を分離する。
2. **[P1] 推定所要時間が固定仮定**: 公式ダイヤ・寄港順から計算した値ではなく、しかも重要度上位。公式の出発・到着予定時刻または便別ダイヤマスタへ置換する。
3. **[P1] 再解析から予報への分布差**: 4日先の各リードタイム（24/48/72/96時間）別に検証し、必要ならリードタイム別校正を行う。
4. **[P2] 新設便番号**: 学習時にない便番号はone-hotが全て0になる。動作はするが、未知カテゴリ率を監視する。
5. **[P2] 港選択は未学習**: 岡田港・元町港の実績は保持しているがモデル入力から除外済み。就航モデルとは別に港予測モデルを作る。

## 本番入力の合格条件

- 全11地点、対象時間の予報が取得できる
- JST、m/s、m、s、hPa、mm、%が学習時と一致する
- 公式ダイヤから出航・到着時刻を決定できる
- 127入力の欠損率と範囲を学習時分布と比較する
- 24/48/72/96時間先ごとにRecall、誤警報率、確率校正を確認する
- 欠損時は中央値で黙って補完するだけでなく、利用者に予報不足を表示する
