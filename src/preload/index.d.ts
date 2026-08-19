import type { GitLabBarApi } from './index'

declare global {
  interface Window {
    api: GitLabBarApi
  }
}
