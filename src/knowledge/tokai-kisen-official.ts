export const TOKAI_KISEN_OFFICIAL = {
  source: "東海汽船 安全管理規程（ユーザー提供マスター仕様）",
  jet: {
    departurePorts: {
      東京: { windMs: 18, waveM: 1.5, visibilityM: 1000 },
      熱海: { windMs: 18, waveM: 1.0, visibilityM: 800 },
      伊東: { windMs: 18, waveM: 1.0, visibilityM: 800 },
      久里浜: { windMs: 18, waveM: 1.0, visibilityM: 800 },
      館山: { windMs: 18, waveM: 1.0, visibilityM: 800 }
    },
    route: {
      departureStop: { windMs: 18, waveM: 3.0 },
      navigationChange: { windMs: 15, waveM: 2.5 },
      navigationStop: { windMs: 18, waveM: 3.0 }
    },
    oshimaEntry: { windMs: 18, waveM: 1.0, visibilityM: 800 },
    visibility: { navigationChangeM: 4500, foilStopM: 1000, navigationStopM: 800 }
  },
  large: {
    route: {
      departureStop: { windMs: 23, waveM: 5.0 },
      navigationChange: { windMs: 20, waveM: 4.0 }
    },
    oshimaEntry: { windMs: 18, waveM: 1.5, visibilityM: 500 }
  },
  cautions: [
    "未来予報と実際の運航判断時点の現場状況は異なるため、基準到達予報だけで欠航確率100%または就航確率0%にしない。",
    "公式基準と内部の基準比率を混同しない。比率90%等は公式な警戒基準ではない。",
    "ジェットフォイルと大型客船に同じ閾値を適用しない。"
  ]
} as const;

