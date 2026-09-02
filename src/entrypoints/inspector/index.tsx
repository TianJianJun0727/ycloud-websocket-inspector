import { createRoot } from 'react-dom/client';

import './index.css';
import { App } from './App';

const rootElement = document.getElementById('inspector-root');

if (!rootElement) throw new Error('找不到 Inspector 根节点');

createRoot(rootElement).render(<App />);
