const RU = {
 'МҰҒАЛІМГЕ АРНАЛҒАН':'ДЛЯ УЧИТЕЛЕЙ',
 'ПРЕЗЕНТАЦИЯ':'ПРЕЗЕНТАЦИЯ', 'ГЕОМЕТРИЯ':'ГЕОМЕТРИЯ',
 'ОЙЫН АРҚЫЛЫ ҚАЙТАЛАУ':'ПОВТОРЯЕМ В ИГРЕ', 'ЗАТТАРДЫ САНАУ':'СЧИТАЕМ ПРЕДМЕТЫ',
 'Wordwall ойындары':'Игры Wordwall', 'САНДАРДЫ САЛЫСТЫРУ':'СРАВНИВАЕМ ЧИСЛА',
 'САБАҚҚА ДАЙЫНДЫҚ':'ПОДГОТОВКА К УРОКУ', 'Пән мен сынып':'Предмет и класс',
 'Сабақ тақырыбы':'Тема урока', 'Оқу мақсаты':'Цель обучения', 'Сабаққа идея':'Идея для урока',
 'Мұғалімге көмек':'Помощь учителю', 'Презентация':'Презентация', 'Жұмыс парағы':'Рабочий лист',
 'Ойындар':'Игры', 'КЕЛЕСІ ВИДЕОДА КЕЗДЕСКЕНШЕ':'ДО ВСТРЕЧИ В НОВОМ ВИДЕО',
 'БІР САБАҚ. БІР ЖАҢА ИДЕЯ.':'ОДИН УРОК. ОДНА НОВАЯ ИДЕЯ.',
 'АВТОРЛЫҚ МЫСАЛ':'АВТОРСКИЙ ПРИМЕР', 'ЖАУАБЫН ОЙЛАН':'ПОДУМАЙ НАД ОТВЕТОМ',
 'ЖАУАБЫ':'ОТВЕТ', 'СЕКУНД':'СЕКУНД'
};
export function languageOf(value) {
  if (value === 'kk' || value === 'kk-KZ') return 'kk';
  if (value === 'ru' || value === 'ru-RU') return 'ru';
  throw new Error('Language must be kk or ru');
}
export function tr(theme, text) {return languageOf(theme.language || 'kk') === 'ru' ? RU[text] || text : text;}
export function localizedTheme(theme, language) {
  const result = structuredClone(theme);
  result.language = languageOf(language);
  if (result.language === 'ru') result.cta = {...result.cta,
    label:'ДЛЯ СЛЕДУЮЩЕГО УРОКА', headline:'Сохраните\nк следующему уроку',
    body:'Этот приём будет под рукой.', action:'Сохраните видео'};
  return result;
}
export function callToAction(language) {
  return languageOf(language) === 'ru' ? 'Сохраните для следующего урока.' : 'Келесі сабаққа сақтап қойыңыз.';
}
