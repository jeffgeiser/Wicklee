import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { perfMark } from './utils/perfMark';
import { IS_AGENT } from './utils/buildTarget';

perfMark('wk:entry-start');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

perfMark('wk:render-called');
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary surface={IS_AGENT ? 'agent' : 'site'}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
