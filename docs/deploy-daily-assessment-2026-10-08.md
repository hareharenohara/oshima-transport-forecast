# 日別AI評価・総評UI・コメント上限のPreview公開

- 公開先: https://tokai-kisen-forecast-preview.hareharenohara.workers.dev
- Worker: tokai-kisen-forecast-preview
- Version: 95879ec6-43f4-422c-88a7-7a86c9f668a4
- Prompt: assessment-v20-bounded-comments
- UI資産: v37、Service Worker v13
- 追加マイグレーション: 0016_daily_forecasts.sqlのみ。日別評価テーブル・索引をPreview D1へ適用。
- Production D1への変更なし。実際のAI評価の手動呼び出しなし。

## 検証

- デプロイ前: 全137テストとWorker dry-run成功。
- デプロイ後: healthがstatus=ok、新しいプロンプト版を返す。
- /api/daysが正常応答、5日全てにdaily_forecast項目がある。
- Edgeのテスト用非表示ブラウザーで公開画面を375×900幅で確認。
- 日付カードの展開で、その日の総評が便一覧より先に表示される。
- 横はみ出し・JavaScript実行エラーなし。
- スクリーンショット: outputs/daily-preview-375.png
- 検証データ: outputs/daily-preview-verification.json

確認時点では日別評価は全5日で未生成（pending）。便別・集約別の既存評価は表示される。
新しい日別評価の文章・実AIトークン量・生成成功は、対象日の今後の定期更新後に別途確認する必要がある。
容量判定のトークン計測化と入力圧縮は今回の公開内容に含まれていない。
今回の公開内容は、日別回答・保存・API・UIと、合意した文字数・件数制限。
