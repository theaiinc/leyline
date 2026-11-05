import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Root } from './app';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <Root />
    <Toaster richColors position="bottom-right" />
  </TooltipProvider>,
);
