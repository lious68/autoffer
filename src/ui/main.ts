import { extensionClient } from './client';
import { mountApp } from './app';

mountApp(document.getElementById('app')!, extensionClient);
