import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到根容器 #root')
}

// 不使用 StrictMode：其在开发模式下会重复挂载副作用，
// 导致 PTY 会话被创建两次（M0 原型阶段先规避，见 M0-2 任务）。
createRoot(container).render(<App />)
