import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './app';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <App />
    <Toaster richColors position="bottom-right" />
  </TooltipProvider>,
);
