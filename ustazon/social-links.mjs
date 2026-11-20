import links from './social-links.json' with {type:'json'};

export default links;
export function withWebsite(text='') {
  if(text.includes(links.website))return text;
  return [text,'Сайт: '+links.website].filter(Boolean).join('\n\n');
}
