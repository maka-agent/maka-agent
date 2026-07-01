import { createRoot } from 'react-dom/client';
import { App } from './app';
import { applyCachedThemeBeforeMount } from './cached-theme-bootstrap';
import './styles.css';

applyCachedThemeBeforeMount();
createRoot(document.getElementById('root')!).render(<App />);
