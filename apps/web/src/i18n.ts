import en from '@pinwall/shared/i18n/en.json';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

void i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  keySeparator: false,
  interpolation: { escapeValue: false },
  initAsync: false,
});

export default i18next;
