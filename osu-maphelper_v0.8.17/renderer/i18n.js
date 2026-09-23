/* ============================================================================
   侧栏多语言模块（v0.8.16 新增，修 Bug 1：多语言没有全软件统一、侧栏没有语言更改）

   设计要点
   · 侧栏是纯 IIFE 普通 script（非 ESM），所以这里也用一个立即执行函数挂到 window.I18N，
     由各页面在 state.js 之后、自己的 *-panel.js 之前引入。
   · 语言来源**不在前端自己存**，而是跟着主进程的 config 走（config.visual.lang /
     config.visual.langFollow）——这样才能做到「在 BPM 测速助手里改语言，侧栏跟着变」。
     前端只做一件事：从每次轮询到的 snapshot.config 里读语言，变化时重新渲染文案。
   · 文案替换：HTML 里用 data-i18n="key" 标记；属性（title/placeholder）用
     data-i18n-title / data-i18n-ph="key"。调用 applyTo(document) 即可整页替换。
   · 动态拼接的字符串（如「3 秒后」）走 t(key, {n: 3}) 占位符替换。

   为什么不做成 9 份完整字典？
   侧栏界面元素很少（几十个），且与主软件高度重合。这里直接**共用主软件的用词习惯**，
   只维护侧栏独有的文案，没配到的 key 会回退到 zh，保证任何语言下都不出现空白。
   ============================================================================ */
(function () {
    'use strict';

    var LANGS = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt'];

    // ---- 侧栏文案字典（按 key → 各语言）----
    // 只收侧栏独有的界面文案；公共词汇（导出/设置/关闭…）也一并放这里，方便一处改全侧栏生效。
    var D = {
        // 主窗口
        waitingOsu:      { zh: '等待 osu! 打开制谱器…', en: 'Waiting for osu! editor…', ja: 'osu! エディタを待機中…', ko: 'osu! 에디터 대기 중…', fr: "En attente de l'éditeur osu!…", de: 'Warte auf osu!-Editor…', es: 'Esperando al editor de osu!…', ru: 'Ожидание редактора osu!…', pt: 'Aguardando o editor do osu!…' },
        titleSidebar:    { zh: 'osu! 制谱侧栏', en: 'osu! Mapping Sidebar', ja: 'osu! マッピングサイドバー', ko: 'osu! 매핑 사이드바', fr: 'Barre latérale osu!', de: 'osu!-Mapping-Seitenleiste', es: 'Barra lateral de osu!', ru: 'Боковая панель osu!', pt: 'Barra lateral do osu!' },
        currentBpm:      { zh: '当前 BPM', en: 'Current BPM', ja: '現在の BPM', ko: '현재 BPM', fr: 'BPM actuel', de: 'Aktuelles BPM', es: 'BPM actual', ru: 'Текущий BPM', pt: 'BPM atual' },
        exportTiming:    { zh: '导出 timing', en: 'Export timing', ja: 'timing を書き出し', ko: 'timing 내보내기', fr: 'Exporter le timing', de: 'Timing exportieren', es: 'Exportar timing', ru: 'Экспорт timing', pt: 'Exportar timing' },
        dirtyDraft:      { zh: '有未导出修改', en: 'Unsaved changes', ja: '未書き出しの変更あり', ko: '내보내지 않은 변경 있음', fr: 'Modifications non exportées', de: 'Nicht exportierte Änderungen', es: 'Cambios sin exportar', ru: 'Несохранённые изменения', pt: 'Alterações não exportadas' },
        exportedTo:      { zh: '已导出 → ', en: 'Exported → ', ja: '書き出し完了 → ', ko: '내보냄 → ', fr: 'Exporté → ', de: 'Exportiert → ', es: 'Exportado → ', ru: 'Экспортировано → ', pt: 'Exportado → ' },
        openBackupFolder:{ zh: '打开备份文件夹', en: 'Open backup folder', ja: 'バックアップフォルダを開く', ko: '백업 폴더 열기', fr: 'Ouvrir le dossier de sauvegarde', de: 'Backup-Ordner öffnen', es: 'Abrir carpeta de copias', ru: 'Открыть папку резервных копий', pt: 'Abrir pasta de backup' },
        openExportFolder:{ zh: '打开导出文件夹', en: 'Open export folder', ja: '書き出しフォルダを開く', ko: '내보내기 폴더 열기', fr: "Ouvrir le dossier d'export", de: 'Export-Ordner öffnen', es: 'Abrir carpeta de exportación', ru: 'Открыть папку экспорта', pt: 'Abrir pasta de exportação' },
        backup:          { zh: '备份', en: 'Backup', ja: 'バックアップ', ko: '백업', fr: 'Sauvegarde', de: 'Backup', es: 'Copia de seguridad', ru: 'Резервная копия', pt: 'Backup' },
        settings:        { zh: '设置', en: 'Settings', ja: '設定', ko: '설정', fr: 'Paramètres', de: 'Einstellungen', es: 'Ajustes', ru: 'Настройки', pt: 'Configurações' },
        log:             { zh: '日志', en: 'Log', ja: 'ログ', ko: '로그', fr: 'Journal', de: 'Protokoll', es: 'Registro', ru: 'Журнал', pt: 'Registro' },
        map:             { zh: '谱面', en: 'Beatmap', ja: 'ビートマップ', ko: '비트맵', fr: 'Beatmap', de: 'Beatmap', es: 'Beatmap', ru: 'Карта', pt: 'Beatmap' },
        openViz:         { zh: '频谱窗', en: 'Spectrum', ja: 'スペクトラム', ko: '스펙트럼', fr: 'Spectre', de: 'Spektrum', es: 'Espectro', ru: 'Спектр', pt: 'Espectro' },
        pinOnTop:        { zh: '窗口置顶', en: 'Always on top', ja: '常に手前', ko: '항상 위', fr: 'Toujours au-dessus', de: 'Immer im Vordergrund', es: 'Siempre visible', ru: 'Поверх окон', pt: 'Sempre no topo' },
        close:           { zh: '关闭', en: 'Close', ja: '閉じる', ko: '닫기', fr: 'Fermer', de: 'Schließen', es: 'Cerrar', ru: 'Закрыть', pt: 'Fechar' },
        backToMeasurer:  { zh: '↩ 返回测速', en: '↩ Back to Measurer', ja: '↩ 測速に戻る', ko: '↩ 측정기로', fr: '↩ Retour', de: '↩ Zurück', es: '↩ Volver', ru: '↩ Назад', pt: '↩ Voltar' },
        backToMeasurerTip: { zh: '返回 BPM 测速助手主界面', en: 'Back to BPM Measurer main window', ja: 'BPM 測速助手のメイン画面に戻る', ko: 'BPM 측정기 메인 화면으로 돌아가기', fr: 'Revenir à la fenêtre principale de BPM Measurer', de: 'Zurück zum Hauptfenster von BPM Measurer', es: 'Volver a la ventana principal', ru: 'Вернуться в главное окно BPM Measurer', pt: 'Voltar à janela principal do BPM Measurer' },
        totalLength:     { zh: '总时长', en: 'Total', ja: '総時間', ko: '총 길이', fr: 'Durée totale', de: 'Gesamt', es: 'Duración', ru: 'Всего', pt: 'Duração' },
        blocks:          { zh: '功能区块', en: 'Panels', ja: '機能パネル', ko: '기능 패널', fr: 'Panneaux', de: 'Bereiche', es: 'Paneles', ru: 'Панели', pt: 'Painéis' },
        launchViz:       { zh: '📊 频谱声谱 + 变速段落', en: '📊 Spectrum + SV sections', ja: '📊 スペクトラム + 速度区間', ko: '📊 스펙트럼 + 속도 구간', fr: '📊 Spectre + sections SV', de: '📊 Spektrum + SV-Abschnitte', es: '📊 Espectro + secciones SV', ru: '📊 Спектр + участки SV', pt: '📊 Espectro + seções SV' },
        launchMap:       { zh: '🗺 谱面信息', en: '🗺 Beatmap info', ja: '🗺 ビートマップ情報', ko: '🗺 비트맵 정보', fr: '🗺 Infos beatmap', de: '🗺 Beatmap-Info', es: '🗺 Info del beatmap', ru: '🗺 Инфо карты', pt: '🗺 Info do beatmap' },
        launchBackup:    { zh: '💾 自动备份', en: '💾 Auto backup', ja: '💾 自動バックアップ', ko: '💾 자동 백업', fr: '💾 Sauvegarde auto', de: '💾 Auto-Backup', es: '💾 Copia automática', ru: '💾 Автобэкап', pt: '💾 Backup automático' },
        launchSettings:  { zh: '⚙ 设置', en: '⚙ Settings', ja: '⚙ 設定', ko: '⚙ 설정', fr: '⚙ Paramètres', de: '⚙ Einstellungen', es: '⚙ Ajustes', ru: '⚙ Настройки', pt: '⚙ Configurações' },
        launchLog:       { zh: '📜 日志', en: '📜 Log', ja: '📜 ログ', ko: '📜 로그', fr: '📜 Journal', de: '📜 Protokoll', es: '📜 Registro', ru: '📜 Журнал', pt: '📜 Registro' },
        notModified:     { zh: '未修改', en: 'No changes', ja: '変更なし', ko: '변경 없음', fr: 'Aucune modification', de: 'Keine Änderung', es: 'Sin cambios', ru: 'Без изменений', pt: 'Sem alterações' },
        exportFailed:    { zh: '失败：', en: 'Failed: ', ja: '失敗：', ko: '실패: ', fr: 'Échec : ', de: 'Fehlgeschlagen: ', es: 'Error: ', ru: 'Ошибка: ', pt: 'Falha: ' },
        openSaveFolder:  { zh: '📂 打开保存文件夹', en: '📂 Open save folder', ja: '📂 保存先フォルダを開く', ko: '📂 저장 폴더 열기', fr: "📂 Ouvrir le dossier d'enregistrement", de: '📂 Speicherordner öffnen', es: '📂 Abrir carpeta de guardado', ru: '📂 Открыть папку сохранения', pt: '📂 Abrir pasta de salvamento' },
        openSaveFolderTip:{ zh: '打开 timing 导出的保存文件夹', en: 'Open the folder where timing exports are saved', ja: 'timing 書き出し先フォルダを開く', ko: 'timing 내보내기 저장 폴더 열기', fr: "Ouvrir le dossier d'export du timing", de: 'Ordner der Timing-Exporte öffnen', es: 'Abrir la carpeta de exportación de timing', ru: 'Открыть папку экспорта timing', pt: 'Abrir a pasta de exportação de timing' },
        openBackupFolderTip:{ zh: '打开定时备份文件夹', en: 'Open the scheduled backup folder', ja: '定期バックアップフォルダを開く', ko: '정기 백업 폴더 열기', fr: 'Ouvrir le dossier de sauvegarde planifiée', de: 'Ordner der geplanten Backups öffnen', es: 'Abrir la carpeta de copias programadas', ru: 'Открыть папку резервных копий', pt: 'Abrir a pasta de backups agendados' },
        // 时间格式
        secLater:        { zh: '{n} 秒后', en: 'in {n}s', ja: '{n} 秒後', ko: '{n}초 후', fr: 'dans {n} s', de: 'in {n} s', es: 'en {n} s', ru: 'через {n} с', pt: 'em {n}s' },
        minSecLater:     { zh: '{m} 分 {s} 秒后', en: 'in {m}m {s}s', ja: '{m} 分 {s} 秒後', ko: '{m}분 {s}초 후', fr: 'dans {m} min {s} s', de: 'in {m} min {s} s', es: 'en {m} min {s} s', ru: 'через {m} мин {s} с', pt: 'em {m}min {s}s' },
        // 频谱窗
        autoFollow:      { zh: '⏭ 自动翻页', en: '⏭ Auto-scroll', ja: '⏭ 自動スクロール', ko: '⏭ 자동 스크롤', fr: '⏭ Défilement auto', de: '⏭ Auto-Scroll', es: '⏭ Desplaz. auto', ru: '⏭ Автопрокрутка', pt: '⏭ Rolagem auto' },
        // ---- 频谱窗（viz）----
        svSections:      { zh: '变速段落', en: 'SV sections', ja: '速度区間', ko: '속도 구간', fr: 'Sections SV', de: 'SV-Abschnitte', es: 'Secciones SV', ru: 'Участки SV', pt: 'Seções SV' },
        noData:          { zh: '暂无数据', en: 'No data', ja: 'データなし', ko: '데이터 없음', fr: 'Aucune donnée', de: 'Keine Daten', es: 'Sin datos', ru: 'Нет данных', pt: 'Sem dados' },
        globalOffset:    { zh: '全局起始偏移（offset）', en: 'Global offset', ja: 'グローバル offset', ko: '전역 오프셋 (offset)', fr: 'Offset global', de: 'Globaler Offset', es: 'Offset global', ru: 'Глобальный offset', pt: 'Offset global' },
        sectionIndex:    { zh: '变速段落编号', en: 'SV section index', ja: '速度区間の番号', ko: '속도 구간 번호', fr: 'N° de section SV', de: 'SV-Abschnittsnummer', es: 'N.º de sección SV', ru: 'Номер участка SV', pt: 'N.º da seção SV' },
        addSvSection:    { zh: '＋ 添加变速段落', en: '＋ Add SV section', ja: '＋ 速度区間を追加', ko: '＋ 속도 구간 추가', fr: '＋ Ajouter une section', de: '＋ SV-Abschnitt hinzufügen', es: '＋ Añadir sección SV', ru: '＋ Добавить участок', pt: '＋ Adicionar seção SV' },
        deleteSection:   { zh: '✕ 删除', en: '✕ Delete', ja: '✕ 削除', ko: '✕ 삭제', fr: '✕ Supprimer', de: '✕ Löschen', es: '✕ Eliminar', ru: '✕ Удалить', pt: '✕ Excluir' },
        metronome:       { zh: '♩ 节拍器', en: '♩ Metronome', ja: '♩ メトロノーム', ko: '♩ 메트로놈', fr: '♩ Métronome', de: '♩ Metronom', es: '♩ Metrónomo', ru: '♩ Метроном', pt: '♩ Metrônomo' },
        clickHint:       { zh: '点频谱红线 → 跳到对应段落卡片 · 双击卡片 → 频谱居中', en: 'Click a red line → jump to its card · Double-click a card → center the view', ja: '赤線をクリック → 対応カードへ · カードをダブルクリック → 中央に表示', ko: '빨간 선 클릭 → 해당 카드로 · 카드 더블클릭 → 화면 중앙', fr: 'Clic sur une ligne rouge → aller à la carte · Double-clic sur une carte → centrer', de: 'Rote Linie klicken → zur Karte · Karte doppelklicken → zentrieren', es: 'Clic en línea roja → ir a su tarjeta · Doble clic en tarjeta → centrar', ru: 'Клик по красной линии → к карточке · Двойной клик по карточке → по центру', pt: 'Clique na linha vermelha → ir ao cartão · Duplo clique no cartão → centralizar' },
        // 设置项标题
        langSection:     { zh: '语言 / Language', en: 'Language / 语言', ja: '言語 / Language', ko: '언어 / Language', fr: 'Langue / Language', de: 'Sprache / Language', es: 'Idioma / Language', ru: 'Язык / Language', pt: 'Idioma / Language' },
        langFollow:      { zh: '跟随软件', en: 'Follow app', ja: 'アプリに追従', ko: '앱 설정 따르기', fr: "Suivre l'application", de: 'App folgen', es: 'Seguir la app', ru: 'Как в приложении', pt: 'Seguir o app' },
        langReload:      { zh: '⟳ 重新读取', en: '⟳ Reload', ja: '⟳ 再読み込み', ko: '⟳ 다시 읽기', fr: '⟳ Recharger', de: '⟳ Neu laden', es: '⟳ Recargar', ru: '⟳ Обновить', pt: '⟳ Recarregar' },
        langReloadTip:   { zh: '重新读取 BPM 测速助手的语言设置（在软件里改完语言后点一下）', en: 'Re-read the language setting from BPM Measurer (click after changing it in the app)', ja: 'BPM 測速助手の言語設定を再読み込みします（アプリで変更後にクリック）', ko: 'BPM 측정기의 언어 설정을 다시 읽습니다 (앱에서 변경 후 클릭)', fr: "Relire la langue définie dans BPM Measurer (cliquez après l'avoir changée)", de: 'Spracheinstellung von BPM Measurer neu einlesen (nach Änderung klicken)', es: 'Releer el idioma de BPM Measurer (pulsa tras cambiarlo)', ru: 'Перечитать язык из BPM Measurer (нажмите после изменения)', pt: 'Releia o idioma do BPM Measurer (clique após alterar)' },
        sidebarLang:     { zh: '侧栏语言', en: 'Sidebar language', ja: 'サイドバーの言語', ko: '사이드바 언어', fr: 'Langue de la barre latérale', de: 'Seitenleisten-Sprache', es: 'Idioma de la barra', ru: 'Язык панели', pt: 'Idioma da barra' },
        langSourceReading:{ zh: '语言来源：读取中…', en: 'Language source: reading…', ja: '言語の取得元：読み込み中…', ko: '언어 출처: 읽는 중…', fr: 'Source de la langue : lecture…', de: 'Sprachquelle: wird gelesen…', es: 'Origen del idioma: leyendo…', ru: 'Источник языка: чтение…', pt: 'Origem do idioma: lendo…' },
        langFromApp:     { zh: '语言来源：跟随 BPM 测速助手（{lang}）', en: 'Language source: following BPM Measurer ({lang})', ja: '言語の取得元：BPM 測速助手に追従（{lang}）', ko: '언어 출처: BPM 측정기 따름 ({lang})', fr: "Source : BPM Measurer ({lang})", de: 'Sprache von BPM Measurer ({lang})', es: 'Origen: BPM Measurer ({lang})', ru: 'Источник: BPM Measurer ({lang})', pt: 'Origem: BPM Measurer ({lang})' },
        langManual:      { zh: '语言来源：侧栏单独指定', en: 'Language source: set for sidebar only', ja: '言語の取得元：サイドバー個別設定', ko: '언어 출처: 사이드바 개별 설정', fr: 'Source : propre à la barre latérale', de: 'Sprache: nur für die Seitenleiste', es: 'Origen: solo barra lateral', ru: 'Источник: только для панели', pt: 'Origem: apenas a barra lateral' },
        langReadFail:    { zh: '语言来源：读取失败，已回退到侧栏语言', en: 'Language source: read failed, using sidebar language', ja: '言語の取得元：読み込み失敗、サイドバー設定を使用', ko: '언어 출처: 읽기 실패, 사이드바 설정 사용', fr: 'Lecture échouée, langue de la barre utilisée', de: 'Lesen fehlgeschlagen, Seitenleisten-Sprache aktiv', es: 'Lectura fallida, usando idioma propio', ru: 'Ошибка чтения, используется язык панели', pt: 'Falha ao ler, usando idioma da barra' },
        langHint:        { zh: '侧栏与测速助手是两个独立程序，语言默认「跟随软件」——直接采用你在测速助手设置里选的语言。取消勾选后可单独为侧栏指定语言。', en: 'The sidebar and BPM Measurer are separate programs. Language follows the app by default — it uses whatever you picked in BPM Measurer. Uncheck to set a language just for the sidebar.', ja: 'サイドバーと BPM 測速助手は別々のプログラムです。既定では「アプリに追従」し、測速助手で選んだ言語を使います。チェックを外すとサイドバー専用の言語を指定できます。', ko: '사이드바와 BPM 측정기는 별개 프로그램입니다. 기본은 앱 따르기이며, 측정기에서 고른 언어를 사용합니다. 해제하면 사이드바만 따로 지정할 수 있습니다.', fr: "La barre latérale et BPM Measurer sont deux programmes distincts. Par défaut elle suit l'application. Décochez pour définir une langue propre.", de: 'Die Seitenleiste und BPM Measurer sind getrennte Programme. Standardmäßig folgt die Sprache der App. Zum Festlegen einer eigenen Sprache abwählen.', es: 'La barra lateral y BPM Measurer son programas distintos. Por defecto el idioma sigue a la app. Desmarca para elegir uno propio.', ru: 'Панель и BPM Measurer — разные программы. По умолчанию язык берётся из приложения. Снимите галочку, чтобы задать свой.', pt: 'A barra lateral e o BPM Measurer são programas separados. O idioma segue o app por padrão. Desmarque para definir um próprio.' },
        // ---- 各面板通用（标题栏 / 按钮 / 提示）----
        pinTip:          { zh: '切换置顶（默认置顶）', en: 'Toggle always-on-top (on by default)', ja: '常に手前を切替（既定でオン）', ko: '항상 위 고정 전환 (기본 켜짐)', fr: 'Basculer « toujours au-dessus » (activé par défaut)', de: '„Immer im Vordergrund“ umschalten (standardmäßig an)', es: 'Alternar «siempre visible» (activado por defecto)', ru: 'Переключить «поверх окон» (по умолчанию вкл.)', pt: 'Alternar “sempre no topo” (ativo por padrão)' },
        // 谱面信息面板
        titleMap:        { zh: '谱面信息', en: 'Beatmap info', ja: 'ビートマップ情報', ko: '비트맵 정보', fr: 'Infos beatmap', de: 'Beatmap-Info', es: 'Info del beatmap', ru: 'Инфо карты', pt: 'Info do beatmap' },
        curBeatmap:      { zh: '当前谱面', en: 'Current beatmap', ja: '現在のビートマップ', ko: '현재 비트맵', fr: 'Beatmap actuel', de: 'Aktuelle Beatmap', es: 'Beatmap actual', ru: 'Текущая карта', pt: 'Beatmap atual' },
        rescan:          { zh: '重探', en: 'Rescan', ja: '再探索', ko: '재검색', fr: 'Rescanner', de: 'Neu scannen', es: 'Reescanear', ru: 'Пересканировать', pt: 'Reescanear' },
        rescanTip:       { zh: '重新探测 osu! 目录 / 重读谱面', en: 'Re-detect the osu! folder and re-read the beatmap', ja: 'osu! フォルダを再検出 / ビートマップを再読み込み', ko: 'osu! 폴더 재감지 / 비트맵 다시 읽기', fr: "Redétecter le dossier osu! et relire la beatmap", de: 'osu!-Ordner neu erkennen / Beatmap neu lesen', es: 'Redetectar la carpeta de osu! y releer el beatmap', ru: 'Повторно найти папку osu! и перечитать карту', pt: 'Redetectar a pasta do osu! e reler o beatmap' },
        redLine:         { zh: '红线', en: 'Red lines', ja: '赤線', ko: '빨간 선', fr: 'Lignes rouges', de: 'Rote Linien', es: 'Líneas rojas', ru: 'Красные линии', pt: 'Linhas vermelhas' },
        greenLine:       { zh: '绿线', en: 'Green lines', ja: '緑線', ko: '초록 선', fr: 'Lignes vertes', de: 'Grüne Linien', es: 'Líneas verdes', ru: 'Зелёные линии', pt: 'Linhas verdes' },
        consistency:     { zh: '一致性', en: 'Consistency', ja: '整合性', ko: '일치성', fr: 'Cohérence', de: 'Konsistenz', es: 'Coherencia', ru: 'Согласованность', pt: 'Consistência' },
        // 自动备份面板
        autoBackup:      { zh: '自动备份', en: 'Auto backup', ja: '自動バックアップ', ko: '자동 백업', fr: 'Sauvegarde auto', de: 'Auto-Backup', es: 'Copia automática', ru: 'Автобэкап', pt: 'Backup automático' },
        backupNow:       { zh: '立即备份', en: 'Back up now', ja: '今すぐバックアップ', ko: '지금 백업', fr: 'Sauvegarder maintenant', de: 'Jetzt sichern', es: 'Copiar ahora', ru: 'Создать копию', pt: 'Fazer backup agora' },
        backupNowTip:    { zh: '立刻备份一次', en: 'Back up once right now', ja: 'すぐに 1 回バックアップ', ko: '지금 한 번 백업', fr: 'Sauvegarder immédiatement', de: 'Sofort einmal sichern', es: 'Hacer copia ahora mismo', ru: 'Сделать копию сейчас', pt: 'Fazer backup agora mesmo' },
        nextAt:          { zh: '下次', en: 'Next', ja: '次回', ko: '다음', fr: 'Prochaine', de: 'Nächste', es: 'Próxima', ru: 'Следующая', pt: 'Próxima' },
        stored:          { zh: '已存', en: 'Stored', ja: '保存数', ko: '저장됨', fr: 'Stockées', de: 'Gespeichert', es: 'Guardadas', ru: 'Сохранено', pt: 'Armazenados' },
        usedSpace:       { zh: '占用', en: 'Size', ja: '使用量', ko: '사용량', fr: 'Occupé', de: 'Belegt', es: 'Ocupado', ru: 'Занято', pt: 'Ocupado' },
        intervalLabel:   { zh: '间隔', en: 'Every', ja: '間隔', ko: '간격', fr: 'Intervalle', de: 'Intervall', es: 'Intervalo', ru: 'Интервал', pt: 'Intervalo' },
        unitMin:         { zh: '分', en: 'min', ja: '分', ko: '분', fr: 'min', de: 'Min', es: 'min', ru: 'мин', pt: 'min' },
        keepLabel:       { zh: '保留', en: 'Keep', ja: '保持', ko: '보관', fr: 'Conserver', de: 'Behalten', es: 'Conservar', ru: 'Хранить', pt: 'Manter' },
        unitCopies:      { zh: '份', en: 'files', ja: '個', ko: '개', fr: 'fichiers', de: 'Dateien', es: 'archivos', ru: 'шт.', pt: 'arquivos' },
        enabled:         { zh: '启用', en: 'Enabled', ja: '有効', ko: '사용', fr: 'Activé', de: 'Aktiviert', es: 'Activado', ru: 'Включено', pt: 'Ativado' },
        backupLocation:  { zh: '备份位置', en: 'Backup folder', ja: 'バックアップ先', ko: '백업 위치', fr: 'Emplacement', de: 'Speicherort', es: 'Ubicación', ru: 'Расположение', pt: 'Local' },
        backupDirPh:     { zh: '留空 = 默认目录', en: 'Leave empty for the default folder', ja: '空欄 = 既定フォルダ', ko: '비우면 기본 폴더', fr: 'Vide = dossier par défaut', de: 'Leer = Standardordner', es: 'Vacío = carpeta por defecto', ru: 'Пусто = папка по умолчанию', pt: 'Vazio = pasta padrão' },
        backupDirTip:    { zh: '备份文件保存位置，可自行更改', en: 'Where backups are saved — you can change it', ja: 'バックアップの保存先（変更可）', ko: '백업 저장 위치 (변경 가능)', fr: 'Emplacement des sauvegardes, modifiable', de: 'Speicherort der Backups, änderbar', es: 'Ubicación de las copias, modificable', ru: 'Расположение копий, можно изменить', pt: 'Local dos backups, pode alterar' },
        // ---- 设置面板：窗口透明度 ----
        secOpacity:      { zh: '窗口透明度（各自独立）', en: 'Window opacity (per window)', ja: 'ウィンドウ透明度（個別）', ko: '창 투명도 (각자)', fr: 'Opacité des fenêtres (par fenêtre)', de: 'Fensterdeckkraft (je Fenster)', es: 'Opacidad de ventana (individual)', ru: 'Прозрачность окон (для каждого)', pt: 'Opacidade da janela (individual)' },
        winMain:         { zh: '侧栏主窗口', en: 'Sidebar main window', ja: 'サイドバー本体', ko: '사이드바 메인 창', fr: 'Fenêtre principale', de: 'Seitenleisten-Hauptfenster', es: 'Ventana principal', ru: 'Главное окно панели', pt: 'Janela principal da barra' },
        winViz:          { zh: '频谱声谱 + 变速段落', en: 'Spectrum + SV sections', ja: 'スペクトラム + 速度区間', ko: '스펙트럼 + 속도 구간', fr: 'Spectre + sections SV', de: 'Spektrum + SV-Abschnitte', es: 'Espectro + secciones SV', ru: 'Спектр + участки SV', pt: 'Espectro + seções SV' },
        winSettings:     { zh: '设置（本窗口）', en: 'Settings (this window)', ja: '設定（このウィンドウ）', ko: '설정 (이 창)', fr: 'Paramètres (cette fenêtre)', de: 'Einstellungen (dieses Fenster)', es: 'Ajustes (esta ventana)', ru: 'Настройки (это окно)', pt: 'Configurações (esta janela)' },
        tipOpacityInput: { zh: '直接输入透明度百分比', en: 'Type the opacity percentage', ja: '透明度を直接入力', ko: '투명도 직접 입력', fr: "Saisir le pourcentage d'opacité", de: 'Deckkraft-Prozent direkt eingeben', es: 'Escribe el porcentaje de opacidad', ru: 'Введите процент прозрачности', pt: 'Digite a porcentagem de opacidade' },
        hintOpacity:     { zh: '每个窗口单独调，改完立刻生效（主进程每 0.5 秒同步一次）。滑条右侧的数字框可直接输入数值。', en: 'Each window is adjusted separately and changes apply instantly (the main process syncs every 0.5 s). You can type a value in the box next to each slider.', ja: 'ウィンドウごとに個別設定、変更は即反映（0.5 秒ごとに同期）。右の数値ボックスに直接入力できます。', ko: '창마다 개별 조정, 즉시 적용(0.5초마다 동기화). 슬라이더 오른쪽 숫자 칸에 직접 입력 가능.', fr: 'Chaque fenêtre se règle séparément, application immédiate (synchronisation toutes les 0,5 s). Vous pouvez saisir une valeur dans la case à droite.', de: 'Jedes Fenster wird einzeln eingestellt, Änderungen wirken sofort (Sync alle 0,5 s). Wert direkt ins Feld rechts eingeben.', es: 'Cada ventana se ajusta por separado y los cambios se aplican al instante (sincronización cada 0,5 s). Puedes escribir un valor en la casilla.', ru: 'Каждое окно настраивается отдельно, изменения применяются сразу (синхронизация каждые 0,5 с). Значение можно ввести в поле справа.', pt: 'Cada janela é ajustada separadamente e aplica na hora (sincroniza a cada 0,5 s). Digite o valor na caixa ao lado.' },
        // ---- 设置面板：频谱 / 声谱 ----
        secVisual:       { zh: '频谱 / 声谱（同软件设置）', en: 'Spectrum / spectrogram (same as the app)', ja: 'スペクトラム / 声譜（ソフトと共通）', ko: '스펙트럼 / 스펙트로그램 (앱과 동일)', fr: "Spectre / spectrogramme (comme dans l'app)", de: 'Spektrum / Spektrogramm (wie in der App)', es: 'Espectro / espectrograma (igual que la app)', ru: 'Спектр / спектрограмма (как в приложении)', pt: 'Espectro / espectrograma (igual ao app)' },
        palette:         { zh: '声谱配色', en: 'Palette', ja: '配色', ko: '색상 팔레트', fr: 'Palette', de: 'Farbpalette', es: 'Paleta', ru: 'Палитра', pt: 'Paleta' },
        customTri:       { zh: '自定义三色', en: 'Custom 3 colors', ja: 'カスタム 3 色', ko: '사용자 지정 3색', fr: '3 couleurs perso.', de: '3 eigene Farben', es: '3 colores personalizados', ru: '3 своих цвета', pt: '3 cores personalizadas' },
        low:             { zh: '低', en: 'Low', ja: '低', ko: '낮음', fr: 'Bas', de: 'Niedrig', es: 'Bajo', ru: 'Низ', pt: 'Baixo' },
        mid:             { zh: '中', en: 'Mid', ja: '中', ko: '중간', fr: 'Moyen', de: 'Mittel', es: 'Medio', ru: 'Сред', pt: 'Médio' },
        high:            { zh: '高', en: 'High', ja: '高', ko: '높음', fr: 'Haut', de: 'Hoch', es: 'Alto', ru: 'Высок', pt: 'Alto' },
        fft:             { zh: 'FFT 精度', en: 'FFT size', ja: 'FFT 精度', ko: 'FFT 크기', fr: 'Précision FFT', de: 'FFT-Größe', es: 'Precisión FFT', ru: 'Точность FFT', pt: 'Precisão FFT' },
        sensitivity:     { zh: '灵敏度', en: 'Sensitivity', ja: '感度', ko: '민감도', fr: 'Sensibilité', de: 'Empfindlichkeit', es: 'Sensibilidad', ru: 'Чувствительность', pt: 'Sensibilidade' },
        tipSensInput:    { zh: '直接输入灵敏度 dB', en: 'Type the sensitivity in dB', ja: '感度（dB）を直接入力', ko: '민감도 직접 입력 (dB)', fr: 'Saisir la sensibilité en dB', de: 'Empfindlichkeit in dB direkt eingeben', es: 'Escribe la sensibilidad en dB', ru: 'Введите чувствительность в дБ', pt: 'Digite a sensibilidade em dB' },
        logScale:        { zh: '对数刻度', en: 'Log scale', ja: '対数スケール', ko: '로그 스케일', fr: 'Échelle log', de: 'Logarithmische Skala', es: 'Escala logarítmica', ru: 'Лог. шкала', pt: 'Escala log' },
        tipLogbaseInput: { zh: '直接输入对数底', en: 'Type the log base', ja: '対数の底を直接入力', ko: '로그 밑 직접 입력', fr: 'Saisir la base du log', de: 'Logarithmenbasis direkt eingeben', es: 'Escribe la base del log', ru: 'Введите основание логарифма', pt: 'Digite a base do log' },
        peakThresh:      { zh: '峰值阈值', en: 'Peak threshold', ja: 'ピーク閾値', ko: '피크 임계값', fr: 'Seuil de crête', de: 'Spitzenschwelle', es: 'Umbral de pico', ru: 'Порог пика', pt: 'Limite de pico' },
        tipPeakInput:    { zh: '直接输入峰值阈值', en: 'Type the peak threshold', ja: 'ピーク閾値を直接入力', ko: '피크 임계값 직접 입력', fr: 'Saisir le seuil de crête', de: 'Spitzenschwelle direkt eingeben', es: 'Escribe el umbral de pico', ru: 'Введите порог пика', pt: 'Digite o limite de pico' },
        peakColorLb:     { zh: '峰值颜色', en: 'Peak color', ja: 'ピーク色', ko: '피크 색상', fr: 'Couleur de crête', de: 'Spitzenfarbe', es: 'Color de pico', ru: 'Цвет пика', pt: 'Cor do pico' },
        hintPeakColor:   { zh: '超过阈值的信号向它过渡', en: 'Signals above the threshold shift toward it', ja: '閾値超えの信号はこの色へ', ko: '임계값 초과 신호는 이 색으로', fr: 'Les signaux au-dessus du seuil tendent vers cette couleur', de: 'Signale über dem Schwellwert gehen in diese Farbe über', es: 'Las señales por encima del umbral viran a este color', ru: 'Сигналы выше порога переходят в этот цвет', pt: 'Sinais acima do limite tendem a esta cor' },
        waveColorLb:     { zh: '波形颜色', en: 'Waveform color', ja: '波形の色', ko: '파형 색상', fr: "Couleur de l'onde", de: 'Wellenfarbe', es: 'Color de onda', ru: 'Цвет волны', pt: 'Cor da onda' },
        invert:          { zh: '垂直倒转', en: 'Flip vertically', ja: '上下反転', ko: '상하 반전', fr: 'Inverser verticalement', de: 'Vertikal spiegeln', es: 'Invertir verticalmente', ru: 'Отразить по вертикали', pt: 'Inverter verticalmente' },
        hintInvert:      { zh: '勾选后高频在下、低频在上', en: 'When checked, highs are at the bottom and lows at the top', ja: 'オンにすると高音域が下、低音域が上', ko: '체크하면 고음역이 아래, 저음역이 위', fr: 'Si coché, les aigus en bas et les graves en haut', de: 'Wenn aktiviert: Höhen unten, Tiefen oben', es: 'Al marcarlo, los agudos abajo y los graves arriba', ru: 'Если отмечено: высокие снизу, низкие сверху', pt: 'Ao marcar, agudos embaixo e graves em cima' },
        renderScale:     { zh: '渲染倍率', en: 'Render scale', ja: '描画倍率', ko: '렌더링 배율', fr: 'Échelle de rendu', de: 'Render-Skalierung', es: 'Escala de renderizado', ru: 'Масштаб рендера', pt: 'Escala de renderização' },
        tipRenderscaleInput:{ zh: '直接输入渲染倍率', en: 'Type the render scale', ja: '描画倍率を直接入力', ko: '렌더링 배율 직접 입력', fr: 'Saisir l’échelle de rendu', de: 'Render-Skalierung direkt eingeben', es: 'Escribe la escala de renderizado', ru: 'Введите масштаб рендера', pt: 'Digite a escala de renderização' },
        beatDelay:       { zh: '节拍线延迟', en: 'Beat line delay', ja: '拍線の遅延', ko: '박선 지연', fr: 'Délai des lignes de temps', de: 'Taktlinien-Verzögerung', es: 'Retardo de líneas de tiempo', ru: 'Задержка линий долей', pt: 'Atraso das linhas de compasso' },
        tipDelayInput:   { zh: '直接输入延迟毫秒', en: 'Type the delay in ms', ja: '遅延（ms）を直接入力', ko: '지연(ms) 직접 입력', fr: 'Saisir le délai en ms', de: 'Verzögerung in ms direkt eingeben', es: 'Escribe el retardo en ms', ru: 'Введите задержку в мс', pt: 'Digite o atraso em ms' },
        bpmReloadTip:    { zh: '重新读取 BPM 测速助手的设置（软件里改完延迟后点一下）', en: "Re-read BPM Measurer's settings (click after changing the delay in the app)", ja: 'BPM 測速助手の設定を再読み込み（アプリで遅延を変更後にクリック）', ko: 'BPM 측정기 설정 다시 읽기 (앱에서 지연 변경 후 클릭)', fr: "Relire les réglages de BPM Measurer (cliquez après avoir changé le délai)", de: 'Einstellungen von BPM Measurer neu lesen (nach Änderung der Verzögerung klicken)', es: 'Releer los ajustes de BPM Measurer (pulsa tras cambiar el retardo)', ru: 'Перечитать настройки BPM Measurer (нажмите после изменения задержки)', pt: 'Reler as configurações do BPM Measurer (clique após mudar o atraso)' },
        showWave:        { zh: '显示波形', en: 'Show waveform', ja: '波形を表示', ko: '파형 표시', fr: "Afficher la forme d'onde", de: 'Wellenform anzeigen', es: 'Mostrar onda', ru: 'Показывать волну', pt: 'Mostrar onda' },
        showSpec:        { zh: '显示声谱', en: 'Show spectrogram', ja: '声譜を表示', ko: '스펙트로그램 표시', fr: 'Afficher le spectrogramme', de: 'Spektrogramm anzeigen', es: 'Mostrar espectrograma', ru: 'Показывать спектрограмму', pt: 'Mostrar espectrograma' },
        delaySrcReading: { zh: '节拍线延迟来源：读取中…', en: 'Beat line delay source: reading…', ja: '拍線遅延の取得元：読み込み中…', ko: '박선 지연 출처: 읽는 중…', fr: 'Source du délai : lecture…', de: 'Quelle der Taktlinien-Verzögerung: wird gelesen…', es: 'Origen del retardo: leyendo…', ru: 'Источник задержки: чтение…', pt: 'Origem do atraso: lendo…' },
        hintDelay:       { zh: '节拍线延迟只偏移红蓝拍线的显示位置（用于对齐 osu! 编辑器画面），不影响频谱/声谱的真实时间轴。勾选「跟随软件」时滑条只读，直接采用 BPM 测速助手里校准好的值。', en: 'The beat line delay only shifts where the red/blue beat lines are drawn (to line them up with the osu! editor view) — it does not change the real timeline of the spectrum/spectrogram. When “Follow app” is checked the slider is read-only and uses the value calibrated in BPM Measurer.', ja: '拍線の遅延は赤/青の拍線の表示位置だけをずらします（osu! エディタの画面に合わせるため）。スペクトラム/声譜の実際の時間軸は変わりません。「アプリに追従」をオンにするとスライダーは読み取り専用になり、BPM 測速助手でキャリブレーションした値を使います。', ko: '박선 지연은 빨강/파랑 박선이 그려지는 위치만 옮깁니다(osu! 에디터 화면에 맞추기 위함). 스펙트럼/스펙트로그램의 실제 시간축은 바뀌지 않습니다. 「앱 따르기」를 켜면 슬라이더는 읽기 전용이 되고 BPM 측정기에서 보정한 값을 사용합니다.', fr: "Le délai des lignes de temps ne décale que leur position à l'écran (pour les aligner sur l'éditeur osu!) ; la chronologie réelle du spectre/spectrogramme n'est pas modifiée. Si « Suivre l'application » est coché, le curseur est en lecture seule et reprend la valeur calibrée dans BPM Measurer.", de: 'Die Taktlinien-Verzögerung verschiebt nur die Darstellung der roten/blauen Taktlinien (zum Ausrichten auf die osu!-Editoransicht). Die echte Zeitachse von Spektrum/Spektrogramm bleibt unverändert. Bei „App folgen“ ist der Schieberegler schreibgeschützt und nutzt den in BPM Measurer kalibrierten Wert.', es: 'El retardo de las líneas de tiempo solo desplaza su posición en pantalla (para alinearlas con el editor de osu!); la línea de tiempo real del espectro/espectrograma no cambia. Con «Seguir la app» el deslizador es de solo lectura y usa el valor calibrado en BPM Measurer.', ru: 'Задержка линий долей сдвигает только их положение на экране (для совмещения с видом редактора osu!); реальная временная шкала спектра/спектрограммы не меняется. При включённом «Как в приложении» ползунок доступен только для чтения и использует значение, откалиброванное в BPM Measurer.', pt: 'O atraso das linhas de compasso só desloca a posição em que são desenhadas (para alinhar com a vista do editor do osu!); a linha de tempo real do espectro/espectrograma não muda. Com “Seguir o app” o slider fica somente leitura e usa o valor calibrado no BPM Measurer.' },
        // ---- 设置面板：跟随 osu! 与帧率 ----
        secFollow:       { zh: '跟随 osu! 与帧率', en: 'Following osu! & frame rate', ja: 'osu! 追従とフレームレート', ko: 'osu! 추종 및 프레임', fr: "Suivi d'osu! et fréquence d'images", de: 'osu!-Verfolgung & Bildrate', es: 'Seguir osu! y FPS', ru: 'Следование osu! и частота кадров', pt: 'Seguir osu! e taxa de quadros' },
        smoothHead:      { zh: '平滑播放头', en: 'Smooth playhead', ja: '再生位置をなめらかに', ko: '부드러운 재생 헤드', fr: 'Tête de lecture fluide', de: 'Glatter Abspielkopf', es: 'Cabezal suave', ru: 'Плавный курсор воспроизведения', pt: 'Cabeçote suave' },
        hintSmooth:      { zh: '跟随 osu! 时按本地时钟外推', en: 'When following osu!, extrapolate with the local clock', ja: 'osu! 追従時にローカル時計で外挿', ko: 'osu! 추종 시 로컬 시계로 외삽', fr: "En suivant osu!, extrapolation via l'horloge locale", de: 'Bei osu!-Verfolgung mit lokaler Uhr extrapolieren', es: 'Al seguir osu!, extrapolar con el reloj local', ru: 'При следовании osu! экстраполяция по локальным часам', pt: 'Ao seguir osu!, extrapolar com o relógio local' },
        extrapMax:       { zh: '外推上限', en: 'Extrap. limit', ja: '外挿の上限', ko: '외삽 한도', fr: "Limite d'extrapolation", de: 'Extrapolationsgrenze', es: 'Límite de extrapolación', ru: 'Предел экстраполяции', pt: 'Limite de extrapolação' },
        tipExtrapInput:  { zh: '直接输入外推上限毫秒', en: 'Type the extrapolation limit in ms', ja: '外挿上限（ms）を直接入力', ko: '외삽 한도(ms) 직접 입력', fr: "Saisir la limite d'extrapolation en ms", de: 'Extrapolationsgrenze in ms direkt eingeben', es: 'Escribe el límite de extrapolación en ms', ru: 'Введите предел экстраполяции в мс', pt: 'Digite o limite de extrapolação em ms' },
        fallbackFps:     { zh: '兜底帧率', en: 'Fallback FPS', ja: '予備フレームレート', ko: '대체 FPS', fr: 'IPS de secours', de: 'Ersatz-Bildrate', es: 'FPS de respaldo', ru: 'Резервный FPS', pt: 'FPS de reserva' },
        fpsOpt30:        { zh: '30 fps（省 CPU，默认）', en: '30 fps (low CPU, default)', ja: '30 fps（低負荷・既定）', ko: '30fps (CPU 절약, 기본)', fr: '30 i/s (économe, défaut)', de: '30 fps (CPU-sparend, Standard)', es: '30 fps (bajo CPU, predet.)', ru: '30 кадр/с (экономно, по умолч.)', pt: '30 fps (baixa CPU, padrão)' },
        fpsOpt60:        { zh: '60 fps', en: '60 fps', ja: '60 fps', ko: '60fps', fr: '60 i/s', de: '60 fps', es: '60 fps', ru: '60 кадр/с', pt: '60 fps' },
        fpsOpt120:       { zh: '120 fps', en: '120 fps', ja: '120 fps', ko: '120fps', fr: '120 i/s', de: '120 fps', es: '120 fps', ru: '120 кадр/с', pt: '120 fps' },
        fpsOptAuto:      { zh: '跟随屏幕刷新率', en: 'Match screen refresh rate', ja: '画面のリフレッシュレートに合わせる', ko: '화면 주사율에 맞춤', fr: 'Suivre le taux de rafraîchissement', de: 'Bildwiederholrate folgen', es: 'Seguir la tasa de refresco', ru: 'По частоте экрана', pt: 'Seguir taxa de atualização' },
        showFpsDiag:     { zh: '显示帧率诊断', en: 'Show FPS diagnostics', ja: 'フレームレート診断を表示', ko: 'FPS 진단 표시', fr: "Afficher le diagnostic d'IPS", de: 'FPS-Diagnose anzeigen', es: 'Mostrar diagnóstico de FPS', ru: 'Показывать диагностику FPS', pt: 'Mostrar diagnóstico de FPS' },
        hintFpsDiag:     { zh: '标题栏出现 rAF/画/兜底 三个数', en: 'Shows rAF / drawn / fallback counters in the title bar', ja: 'タイトルバーに rAF/描画/予備 の 3 つの数値', ko: '제목 표시줄에 rAF/그리기/대체 3개 숫자', fr: 'Affiche rAF / dessin / secours dans la barre de titre', de: 'Zeigt rAF / gezeichnet / Ersatz in der Titelleiste', es: 'Muestra rAF / dibujado / respaldo en la barra de título', ru: 'В заголовке: rAF / отрисовано / резерв', pt: 'Mostra rAF / desenhado / reserva na barra de título' },
        hintFollow:      { zh: 'osu! 的播放位置要经 tosu 与主进程两次轮询才到本窗口，天生是 100~150ms 一跳的离散值——画面每秒只前进约 10 次，看着就像被锁了帧。开启「平滑播放头」后，本窗口按自己的时钟把位置推到每一帧，位置变化从约 10 次/秒提升到每一帧一次。', en: "osu!'s playhead reaches this window only after two polling hops (tosu → the main process), so it is inherently a discrete value that jumps every 100–150 ms — the picture advances only about 10 times per second, which looks like a locked frame rate. With “Smooth playhead” on, this window extrapolates the position from its own clock every frame: updates go from about 10/s to once per frame.", ja: 'osu! の再生位置は tosu → メインプロセスと 2 回のポーリングを経てこのウィンドウに届くため、100~150ms ごとに飛ぶ離散値です。画面は毎秒 10 回程度しか進まず、フレームレートが固定されているように見えます。「再生位置をなめらかに」をオンにすると、本ウィンドウが自分の時計で毎フレーム位置を外挿し、更新が毎秒 10 回程度から毎フレーム 1 回に増えます。', ko: 'osu! 재생 위치는 tosu → 메인 프로세스 두 번의 폴링을 거쳐 이 창에 도달하므로 100~150ms마다 끊기는 이산값입니다. 화면은 초당 10회 정도만 전진해 프레임이 고정된 것처럼 보입니다. 「부드러운 재생 헤드」를 켜면 이 창이 자체 시계로 매 프레임 위치를 외삽해, 갱신이 초당 약 10회에서 프레임당 1회로 늘어납니다.', fr: "La position de lecture d'osu! n'atteint cette fenêtre qu'après deux polls (tosu → processus principal) : c'est donc une valeur discrète qui saute toutes les 100–150 ms. L'image n'avance qu'environ 10 fois par seconde, comme si la fréquence était verrouillée. Avec « Tête de lecture fluide », la fenêtre extrapole la position à chaque frame depuis sa propre horloge : environ 10 mises à jour/s deviennent une par frame.", de: 'Die Abspielposition von osu! erreicht dieses Fenster erst über zwei Poll-Hops (tosu → Hauptprozess) und ist daher von Natur aus ein diskreter Wert, der alle 100–150 ms springt. Das Bild rückt nur etwa 10-mal pro Sekunde vor, was wie eine festgenagelte Bildrate wirkt. Mit „Glatter Abspielkopf“ extrapoliert das Fenster die Position mit der eigenen Uhr pro Frame: von ca. 10 Aktualisierungen/s auf eine pro Frame.', es: 'La posición de reproducción de osu! llega a esta ventana tras dos sondeos (tosu → proceso principal), así que es un valor discreto que salta cada 100–150 ms. La imagen avanza unas 10 veces por segundo, como si los FPS estuvieran bloqueados. Con «Cabezal suave» la ventana extrapola la posición con su propio reloj en cada frame: de unas 10 actualizaciones/s a una por frame.', ru: 'Позиция воспроизведения osu! доходит до этого окна через два опроса (tosu → основной процесс), поэтому это дискретная величина, прыгающая каждые 100–150 мс. Картинка продвигается всего около 10 раз в секунду — выглядит как заблокированный FPS. С «Плавный курсор» окно экстраполирует позицию по своим часам каждый кадр: вместо ~10 обновлений/с — одно на кадр.', pt: 'A posição de reprodução do osu! só chega a esta janela após dois polls (tosu → processo principal), por isso é um valor discreto que salta a cada 100–150 ms. A imagem avança cerca de 10 vezes por segundo, parecendo FPS travado. Com “Cabeçote suave” a janela extrapola a posição com o próprio relógio a cada frame: de ~10 atualizações/s para uma por frame.' },
        hintFpsStat:     { zh: '帧率诊断：rAF = 浏览器派帧速率；画 = 实际绘制速率；兜底 = 由定时器接管的绘制速率。rAF 正常时「兜底」始终为 0。', en: 'FPS diagnostics: rAF = the rate the browser schedules frames; drawn = the actual drawing rate; fallback = draws taken over by the timer. When rAF is healthy, “fallback” stays at 0.', ja: 'フレームレート診断：rAF = ブラウザがフレームを発行する速度、描画 = 実際に描いた速度、予備 = タイマーが代わりに描いた速度。rAF が正常なら「予備」は常に 0 です。', ko: 'FPS 진단: rAF = 브라우저가 프레임을 배정하는 속도, 그리기 = 실제 그린 속도, 대체 = 타이머가 대신 그린 속도. rAF가 정상이면 「대체」는 항상 0입니다.', fr: "Diagnostic d'IPS : rAF = cadence à laquelle le navigateur ordonnance les frames ; dessin = cadence réelle de dessin ; secours = frames pris en charge par le minuteur. Si rAF fonctionne, « secours » reste à 0.", de: 'FPS-Diagnose: rAF = Rate, mit der der Browser Frames einteilt; gezeichnet = tatsächliche Zeichenrate; Ersatz = vom Timer übernommene Frames. Wenn rAF normal läuft, bleibt „Ersatz“ immer 0.', es: 'Diagnóstico de FPS: rAF = ritmo al que el navegador programa los frames; dibujado = ritmo real de dibujo; respaldo = frames asumidos por el temporizador. Si rAF va bien, «respaldo» se queda en 0.', ru: 'Диагностика FPS: rAF = как часто браузер выдаёт кадры; отрисовано = реальная частота отрисовки; резерв = кадры, взятые на себя таймером. Если rAF в норме, «резерв» всегда 0.', pt: 'Diagnóstico de FPS: rAF = ritmo com que o navegador agenda os frames; desenhado = ritmo real de desenho; reserva = frames assumidos pelo temporizador. Com rAF saudável, “reserva” fica em 0.' },
        // ---- 动态状态文案 ----
        delaySrcReloading:{ zh: '节拍线延迟来源：正在重读软件设置…', en: 'Beat line delay source: re-reading app settings…', ja: '拍線遅延の取得元：アプリ設定を再読み込み中…', ko: '박선 지연 출처: 앱 설정 다시 읽는 중…', fr: "Source du délai : relecture des réglages de l'app…", de: 'Quelle der Taktlinien-Verzögerung: App-Einstellungen werden neu gelesen…', es: 'Origen del retardo: releyendo los ajustes de la app…', ru: 'Источник задержки: перечитываем настройки приложения…', pt: 'Origem do atraso: relendo as configurações do app…' },
        delaySrcFail:    { zh: '节拍线延迟来源：读取失败（服务未响应）', en: 'Beat line delay source: read failed (service not responding)', ja: '拍線遅延の取得元：読み込み失敗（サービス未応答）', ko: '박선 지연 출처: 읽기 실패 (서비스 응답 없음)', fr: 'Source du délai : lecture échouée (service sans réponse)', de: 'Quelle: Lesen fehlgeschlagen (Dienst antwortet nicht)', es: 'Origen del retardo: lectura fallida (el servicio no responde)', ru: 'Источник задержки: чтение не удалось (сервис не отвечает)', pt: 'Origem do atraso: falha ao ler (serviço não responde)' },
        delaySrcApp:     { zh: '节拍线延迟来源：BPM 测速助手（当前 {n}ms）', en: 'Beat line delay source: BPM Measurer (currently {n} ms)', ja: '拍線遅延の取得元：BPM 測速助手（現在 {n}ms）', ko: '박선 지연 출처: BPM 측정기 (현재 {n}ms)', fr: 'Source du délai : BPM Measurer (actuellement {n} ms)', de: 'Quelle: BPM Measurer (aktuell {n} ms)', es: 'Origen del retardo: BPM Measurer (actualmente {n} ms)', ru: 'Источник задержки: BPM Measurer (сейчас {n} мс)', pt: 'Origem do atraso: BPM Measurer (atualmente {n} ms)' },
        delaySrcNoSw:    { zh: '节拍线延迟来源：跟随软件，但读不到软件设置（暂用侧栏的 {n}ms）', en: "Beat line delay source: following the app, but its settings can't be read (using the sidebar's {n} ms for now)", ja: '拍線遅延の取得元：アプリに追従中だが設定を読めません（当面はサイドバーの {n}ms を使用）', ko: '박선 지연 출처: 앱 따르기이나 설정을 읽을 수 없음 (우선 사이드바의 {n}ms 사용)', fr: "Source : suit l'app mais ses réglages sont illisibles (utilise {n} ms de la barre pour l'instant)", de: 'Quelle: folgt der App, aber ihre Einstellungen sind nicht lesbar (vorerst {n} ms der Seitenleiste)', es: 'Origen: sigue la app pero no se pueden leer sus ajustes (usa {n} ms de la barra por ahora)', ru: 'Источник: следует приложению, но его настройки не читаются (пока используется {n} мс панели)', pt: 'Origem: segue o app, mas não consegue ler seus ajustes (usando {n} ms da barra por ora)' },
        delaySrcManual:  { zh: '节拍线延迟来源：侧栏手动设置（{n}ms），未跟随软件', en: 'Beat line delay source: set manually in the sidebar ({n} ms), not following the app', ja: '拍線遅延の取得元：サイドバーで手動設定（{n}ms）／アプリには追従していません', ko: '박선 지연 출처: 사이드바 수동 설정 ({n}ms), 앱 따르기 안 함', fr: "Source : réglé manuellement dans la barre ({n} ms), ne suit pas l'app", de: 'Quelle: manuell in der Seitenleiste gesetzt ({n} ms), folgt nicht der App', es: 'Origen: ajustado manualmente en la barra ({n} ms), no sigue la app', ru: 'Источник: задано вручную в панели ({n} мс), приложению не следует', pt: 'Origem: definido manualmente na barra ({n} ms), não segue o app' },
        noAudio:         { zh: '无音频', en: 'No audio', ja: '音声なし', ko: '오디오 없음', fr: 'Aucun audio', de: 'Kein Audio', es: 'Sin audio', ru: 'Нет аудио', pt: 'Sem áudio' },
        decoding:        { zh: '解码中…', en: 'Decoding…', ja: 'デコード中…', ko: '디코딩 중…', fr: 'Décodage…', de: 'Dekodiere…', es: 'Decodificando…', ru: 'Декодирование…', pt: 'Decodificando…' },
        loaded:          { zh: '已载入', en: 'Loaded', ja: '読み込み済み', ko: '로드됨', fr: 'Chargé', de: 'Geladen', es: 'Cargado', ru: 'Загружено', pt: 'Carregado' },
        decodeFailed:    { zh: '解码失败', en: 'Decode failed', ja: 'デコード失敗', ko: '디코딩 실패', fr: 'Échec du décodage', de: 'Dekodierung fehlgeschlagen', es: 'Error de decodificación', ru: 'Ошибка декодирования', pt: 'Falha na decodificação' },
        inSync:          { zh: '同步', en: 'In sync', ja: '同期', ko: '동기화됨', fr: 'Synchronisé', de: 'Synchron', es: 'Sincronizado', ru: 'Синхронно', pt: 'Sincronizado' },
        osuDir:          { zh: 'osu! 目录：', en: 'osu! folder: ', ja: 'osu! フォルダ：', ko: 'osu! 폴더: ', fr: 'Dossier osu! : ', de: 'osu!-Ordner: ', es: 'Carpeta osu!: ', ru: 'Папка osu!: ', pt: 'Pasta do osu!: ' },
        noOsuDir:        { zh: '未找到 osu! 安装目录', en: 'osu! install folder not found', ja: 'osu! のインストール先が見つかりません', ko: 'osu! 설치 폴더를 찾을 수 없음', fr: "Dossier d'installation d'osu! introuvable", de: 'osu!-Installationsordner nicht gefunden', es: 'No se encontró la carpeta de osu!', ru: 'Папка установки osu! не найдена', pt: 'Pasta de instalação do osu! não encontrada' },
        disabled:        { zh: '已停用', en: 'Disabled', ja: '無効', ko: '사용 안 함', fr: 'Désactivé', de: 'Deaktiviert', es: 'Desactivado', ru: 'Отключено', pt: 'Desativado' },
        noRedlines:      { zh: '该谱面没有红线 timing', en: 'This beatmap has no red timing lines', ja: 'このビートマップに赤線 timing はありません', ko: '이 비트맵에는 빨간 timing 선이 없습니다', fr: 'Ce beatmap n\'a pas de lignes rouges', de: 'Diese Beatmap hat keine roten Timing-Linien', es: 'Este beatmap no tiene líneas rojas', ru: 'В этой карте нет красных линий', pt: 'Este beatmap não tem linhas vermelhas' },
        colTime:         { zh: '时间', en: 'Time', ja: '時間', ko: '시간', fr: 'Temps', de: 'Zeit', es: 'Tiempo', ru: 'Время', pt: 'Tempo' },
        colBpm:          { zh: 'BPM', en: 'BPM', ja: 'BPM', ko: 'BPM', fr: 'BPM', de: 'BPM', es: 'BPM', ru: 'BPM', pt: 'BPM' },
        colMeter:        { zh: '拍号', en: 'Meter', ja: '拍子', ko: '박자', fr: 'Mesure', de: 'Takt', es: 'Compás', ru: 'Размер', pt: 'Compasso' },
        modifiedN:       { zh: '已改 {n} 条（导出后生效）', en: '{n} changed', ja: '{n} 件変更', ko: '{n}개 변경됨', fr: '{n} modifié(s)', de: '{n} geändert', es: '{n} modificado(s)', ru: 'Изменено: {n}', pt: '{n} alterado(s)' },
        importing:       { zh: '导入中…', en: 'Importing…', ja: 'インポート中…', ko: '가져오는 중…', fr: 'Importation…', de: 'Importiere…', es: 'Importando…', ru: 'Импорт…', pt: 'Importando…' },
        importedN:       { zh: '已导出 {n} 条红线', en: 'Exported {n} red lines', ja: '{n} 本の赤線を書き出しました', ko: '빨간 선 {n}개 내보냄', fr: '{n} lignes rouges exportées', de: '{n} rote Linien exportiert', es: '{n} líneas rojas exportadas', ru: 'Экспортировано красных линий: {n}', pt: '{n} linhas vermelhas exportadas' },
        frameStat:       { zh: '帧率', en: 'FPS', ja: 'FPS', ko: 'FPS', fr: 'IPS', de: 'FPS', es: 'FPS', ru: 'FPS', pt: 'FPS' },
        noAudioFile:     { zh: '未读取到音频文件', en: 'Audio file not found', ja: '音声ファイルがありません', ko: '오디오 파일 없음', fr: 'Fichier audio introuvable', de: 'Audiodatei nicht gefunden', es: 'Archivo de audio no encontrado', ru: 'Аудиофайл не найден', pt: 'Arquivo de áudio não encontrado' },
    };

    var current = 'zh';

    /** 取当前语言 */
    function getLang() { return current; }

    /** 设置语言（仅内存；持久化由主进程 config 负责） */
    function setLang(l) {
        if (LANGS.indexOf(l) === -1) return;
        current = l;
    }

    /**
     * 取文案。vars 用于占位符替换：t('secLater', { n: 3 }) → '3 秒后'
     * 没配的语言回退到 zh，保证永不空白。
     */
    function t(key, vars) {
        var entry = D[key];
        if (!entry) return key;
        var str = entry[current] || entry.zh || key;
        if (vars) {
            str = str.replace(/\{(\w+)\}/g, function (m, k) {
                return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
            });
        }
        return str;
    }

    /**
     * 把 data-i18n 标记的文案刷进 DOM。
     * · data-i18n="key"        → 替换 textContent
     * · data-i18n-title="key"  → 替换 title 属性
     * · data-i18n-ph="key"     → 替换 placeholder 属性
     */
    function applyTo(root) {
        var scope = root || document;

        var texts = scope.querySelectorAll('[data-i18n]');
        for (var i = 0; i < texts.length; i++) {
            var el = texts[i];
            var key = el.getAttribute('data-i18n');
            if (!key) continue;
            var val = t(key);
            // 允许 data-i18n-vars 传简单 JSON 做占位符
            var varsRaw = el.getAttribute('data-i18n-vars');
            if (varsRaw) {
                try { val = t(key, JSON.parse(varsRaw)); } catch (e) { /* 解析失败就用无参版本 */ }
            }
            el.textContent = val;
        }

        var titles = scope.querySelectorAll('[data-i18n-title]');
        for (var j = 0; j < titles.length; j++) {
            var k2 = titles[j].getAttribute('data-i18n-title');
            if (k2) titles[j].setAttribute('title', t(k2));
        }

        var phs = scope.querySelectorAll('[data-i18n-ph]');
        for (var n = 0; n < phs.length; n++) {
            var k3 = phs[n].getAttribute('data-i18n-ph');
            if (k3) phs[n].setAttribute('placeholder', t(k3));
        }

        // 页面语言属性同步（无障碍/断词）
        try { document.documentElement.lang = current === 'zh' ? 'zh-CN' : current; } catch (e) { /* ignore */ }
    }

    /** 语言显示名（设置面板下拉里用「母语名」，不随语言变化） */
    function langNative(code) {
        var map = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский', pt: 'Português' };
        return map[code] || code;
    }

    window.I18N = { LANGS: LANGS, getLang: getLang, setLang: setLang, t: t, applyTo: applyTo, langNative: langNative };
})();
