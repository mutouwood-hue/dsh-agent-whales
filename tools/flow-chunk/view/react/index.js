// Vendored from deep-view 0.1.2 (https://github.com/Fei2411/deep-view, Apache-2.0), itself ported from DS Bot.
// Copied into dsh-agent-whales on 2026-11-18; maintained here from now on. See NOTICE.md.
export { ViewUi, useViewUi, useOptionKeys, keyLetter } from './ui.js'
export { WidgetCard, WidgetView, ViewMenuList, AnsweredView, WIDGET_CSS } from './card.js'
export { WidgetChart, ChartTable, TableIcon, chartData, chartCsv, formatNumber, niceTicks, CHART_CSS } from './chart.js'
export { HtmlFrame, themeVars, frameDocument, FRAME_POLICY, HTML_CSS } from './frame.js'
export { THEME_CSS, QUESTION_CSS } from './styles.js'
import { WIDGET_CSS } from './card.js'
import { THEME_CSS, QUESTION_CSS } from './styles.js'
export const DEEP_VIEW_CSS = THEME_CSS + QUESTION_CSS + WIDGET_CSS
