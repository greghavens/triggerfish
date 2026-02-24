import DefaultTheme from 'vitepress/theme'
import ComingSoon from './ComingSoon.vue'
import StatusBadge from './StatusBadge.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ComingSoon', ComingSoon)
    app.component('StatusBadge', StatusBadge)
  }
}
