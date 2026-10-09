# AI評価生成失敗の調査（2026-10-01）

## 結論と証拠の範囲

9/30 16:00 JST公開run `1e172ca5-d838-43a6-8524-7ed24bccf34c` の保存済み引き継ぎ記録と、現行コードのオフライン再現を照合した。最新D1はCloudflare API 7403（account invalid / unauthorized）で読み取れず、当該runの生ログも今回再取得できていない。実APIを呼ぶAI検証、アプリ修正、デプロイは行っていない。

保存記録では、31便中28便のAI評価が生成され、3便は気象/MLのみ保存。Groq20bの8グループがすべて失敗（便漏れ3、HTTP400形式不一致2、HTTP429トークン上限3）し、Groq120bには到達していない。Geminiへの切替が累積し、最後のグループでWorker subrequest上限エラーになった。これは過去の調査記録であり、今回取得した新規ログではない。

## 現行コードで再現したこと

再現ファイル: `outputs/diagnostics/reproduce-ai-failures.mjs`。TypeScriptコンパイル後、Nodeで実行。fetchを完全にモックし、ネットワークと資格情報は使わない。

1. Groqへ4便を要求し1便のみ返すと、4便すべてunavailableになる（Geminiキーなしの検証）。20b整理結果の便漏れチェックがthrowし、120bを呼ばない。Geminiキーがあればproviderのcatchからグループ全体のGemini処理へ移る。
2. 実際に送信されるschemaにはservices件数制約とservice_idの入力集合制約がない。1便のみの正しい構造はschemaに反しない。strict=trueは全入力便の網羅を保証していない。便漏れを後段で検出しているが、欠落便IDや返却IDは保存しない。
3. 8便・2グループにすべて429を返すと6通信（各グループGroq1 + Gemini整理モデル2）。グループをまたぐ制限状態の共有やRetry-Afterによる待機はバッチ経路にない。Gemini単便関数にはretryコードがあるが、バッチはretry=falseなので待機しない。
4. Worker上限例外を各fetchからthrowすると、1グループで3通信を試すがaiAudit.attemptsは0。trackedFetchはfetch成功後にしか記録しない。Geminiのモデル列はHTTP400/401/403以外で次モデルを試すため、Worker全体の通信上限でも続行する。
5. scheduledのsuccess_countは保存成功数。aiStatus=unavailableでも保存成功に加算されるので、run completedはAI全便成功を意味しない。

## 原因の整理

- 最終的な欠落の直接原因: 保存済み記録ではGemini制限とWorker通信上限。
- 失敗を増幅する実装要因: Groq便漏れ時の全グループ再処理、429状態を共有しないモデル再試行、Worker上限でもモデル列を継続。
- Groq便漏れを許す要求上の穴: schemaが入力便の網羅を表現していない。これは省略が発生できる理由であり、そのrunでモデルが省略した生成理由の特定ではない。
- 未特定: strict指定でobject期待にarrayを返したHTTP400の発生理由。公式には20b/120bはstrict対応。非対応モデルと判断する根拠はない。
- 未特定: 便漏れが生成打ち切り、ID転記違い、その他の何によるものか。finish_reason、返却ID、応答本文を保存していないため区別不能。入力トークン量と429の時系列も当該runの生記録で再検証が必要。

## 次に必要な証拠

Cloudflare認証を回復後、固定runのrun_logsとai_predictionsを読み、保存記録の件数・順序・HTTP400本文・429本文を再検証する。認証の回復はログインを伴うためユーザー操作が必要になる可能性がある。

過去に保存していない応答はコード解析だけでは復元できない。原因をさらに特定するには、次の自然なCron実行で要求のschema/便ID/段階、応答のfinish_reason/返却ID/usage、エラー種別/時刻/Retry-After、fetch例外を記録する計測変更が候補。ログにAPIキーや認証ヘッダーは含めない。現時点では計測変更も未実装。

## 一次資料（2026-10-01確認）

- https://console.groq.com/docs/structured-outputs : 20b/120bはstrict=true対応。構造保証は指定schemaに対して行われる。
- https://developers.cloudflare.com/workers/platform/limits/ : Freeは外部subrequest 50/実行、redirectも計上。プランの現状は今回未確認。過去の基本fetch件数50は実際の全subrequest実測値ではない。

履歴: `docs/HANDOFF-2026-09-30.md`、`outputs/diagnostics/forecast-quality-2026-09-30.ipynb`。

## API上限の追加確認

ユーザーはGemini評価の停止を希望。今回の追加確認は引き続き原因調査であり、providerや公開環境の停止変更はまだ行っていない。

2026-10-01のGroq公式資料:

| モデル | Free RPM | Free RPD | Free TPM | Free TPD | Developer RPM | Developer TPM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| openai/gpt-oss-20b | 30 | 1,000 | 8,000 | 200,000 | 1,000 | 250,000 |
| openai/gpt-oss-120b | 30 | 1,000 | 8,000 | 200,000 | 1,000 | 250,000 |

Free値は https://console.groq.com/docs/rate-limits 、Developer値は https://console.groq.com/docs/models に掲載。各モデルのcontext windowは131,072、max outputは65,536。アプリの設定値は整理3,500・最終判断7,500。モデル能力の上限と組織の時間あたり上限は異なる。

前回保存記録の20b 429は8,000 TPMでありFree標準と一致。これは過去runでの適用値で、現在の契約や組織全上限の確認ではない。公式上限は組織単位であり、別の利用も影響しうる。現行コードはGroqのRetry-After、残token、reset時刻を参照しない。各グループを逐次処理しても時間あたり消費は制御されない。

https://console.groq.com/settings/limits をブラウザーで開いたが、Login表示とorganization limitsの読込表示にとどまり、認証済みの上限表を取得できなかった。ログインリンク操作もタイムアウト。ローカルには実キーの.dev.varsファイルがなく、GROQ_API_KEY環境変数もないため、応答ヘッダーから実上限を確認する経路も利用できない。キーをチャットに要求せず、Groq Limits画面へログイン後の確認が次の手順。

429は利用制限による失敗。HTTP200便漏れとHTTP400のschema不一致は別の失敗分類であり、8,000 TPMだけですべてを説明しない。整理3,500が不足したかはfinish_reasonなどの証拠がなく未確認。最終判断7,500はそのrunでは120b未到達のため整理失敗の原因ではない。

## 同日・実装後の状態

ユーザーの指示により送信間隔制御と段階計測をローカル実装。Geminiへのprovider切替とmulti-cliのGemini呼出しを停止。Geminiモジュールは型・検証関数と過去互換性のため残っている。

前回runの発生段階は保存済み記録によれば、便漏れは20b整理応答のJSON解析後の便ID照合、形式不一致は20b整理要求に対するGroq API HTTP400（ローカル解析前）。120bは未到達。API内部の生成/検証のどちらで形式が崩れたか、便省略の生成理由は未確定。

現在はstage（summary/final）、phase（api_response/json_parse/output_validation/service_coverage）をエラーへ付記。要求ID・返却ID・finish_reason・応答ルート型・APIエラー・通信例外もaiAuditへ保存する。これにより返却が少ない場合とID違い、length終了、API400とローカル不正JSONを区別できる。本文全量の保存や失敗を隠す形式変換は行わない。

レート制御は同一assessment実行内・モデル別。入力をUTF-8バイト数/2 + 256で概算し、出力の許容上限と合わせて8,000を予約。出力許容上限は8,000から入力概算を引いた範囲へ制限する。窓は最低60秒、サーバーのremaining/reset/Retry-Afterでより長く待機。実使用量が予約を超えた場合も反映。429は1回だけ再試行する。入力概算が7,488以上なら単一要求を送らず、バッチの場合は半分へ分割して処理。単一便でも大きすぎれば明示エラー。概算はモデルの正確なトークナイザーではなく、組織の別実行とは予算共有しないため、429を完全排除する保証はない。

12分を超える待機は明示エラーにし、Cronの15分制限内で保存する余地を残す。ただし実ネットワーク所要時間を含めた15分完了を保証するタイムアウトではない。型検査、71テスト、オフライン再現が成功。公開反映・実AI呼出しは未実施。
