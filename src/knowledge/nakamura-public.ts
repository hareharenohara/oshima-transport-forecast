export const NAKAMURA_PUBLIC = {
  source: "中村氏『伊豆大島 気象と交通』（ユーザー提供マスター仕様に記載された公開経験則）",
  jet: { sagamiWindGuideMs: 17, sagamiWaveGuideM: 4.0 },
  port: {
    okadaWindGuideMs: { min: 7, max: 8 },
    highSwellFavors: "岡田",
    precipitationFavors: "岡田",
    calmFavors: "元町",
    largeShipMorningDefault: "岡田"
  },
  wavePatterns: {
    southwestWind: "大島西側から東京湾口にかけて波が発達しやすく、東京航路のマイナス材料。",
    northeastWind: "局地的な短い吹送距離だけで楽観せず、広域の強風で房総沖等から岡田港へ入るうねりを確認する。",
    strongWesterly: "東京便が欠航でも熱海便が就航する場合があるため、航路別に判断する。",
    waveDevelopment: "波は風速だけでなく、風向、吹送距離、継続時間を合わせて判断する。"
  },
  typhoonSwell: {
    north20deg: "台風が北緯20度を越えると大島へのうねりリスクが高まり得る。",
    lag: "遠方で生成されたうねりは時間差で到達する。47時間を固定ルールにはしない。",
    afterTyphoon: "台風通過・衰弱後も2〜3日程度うねりが残る場合がある。"
  },
  cautions: [
    "東海汽船の公式基準とは別レイヤーの公開経験則として扱う。",
    "公開されていない経験則を追加しない。",
    "ジェット船の17m/s目安を大型客船へ適用しない。"
  ]
} as const;

