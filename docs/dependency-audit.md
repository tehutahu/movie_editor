# 開発用依存の監査（2026-10-22）

基準main `b5ad929` の `npm audit --json` はmoderate 2件、high/critical 0件だった。
依存経路は `devDependencies.vitest@4.1.11 → @vitest/mocker@4.1.11`。
「2件」はこの直接／推移依存の2 package recordsで、上流advisoryは次の2つ。

| 上流advisory | 発生条件・影響 | このリポジトリでの読み取り分類 |
| --- | --- | --- |
| [GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8) | 到達可能なVite dev-server WebSocketでmanual mock登録を受け付けると、生成JavaScriptへ値が混入する | 開発／テスト用。通常の本番Next.js処理へのimportなし。現在のNode test設定にbrowser/mock server公開設定なし |
| [GHSA-xp26-3454-mjgp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp) | Windows上のmock redirectでbackslashを含むpathがallowlistを迂回する | 同じ開発用経路。現在のLinux CI条件とは異なるが、Windows開発時や設定変更後まで無影響とは主張しない |

`package-lock.json`の両packageは`dev: true`。
`npm ls --omit=dev vitest @vitest/mocker`は空で、`app/`・`components/`・`hooks/`・本番`lib/`にimportはない。
`vitest.config.mts`は`environment: "node"`で、CIは`vitest run`を実行する。
`test:watch`は開発用途であり、任意のCLI引数や将来のbrowser/plugin設定まで安全と推定しない。
この分類は設定・依存経路の読み取り結果で、脆弱なserverの公開や攻撃再現は行っていない。

両advisoryの修正済み4.1.12に合わせ、Vitestと結合した`@vitest/*`だけを4.1.12へ更新する。
Vite／Rolldown／本番依存・アプリコード・テスト条件・CIのaudit閾値は変更しない。
更新後の監査結果と最終HEAD CI・通常merge・main CIの証拠は対応PRに記録する。
