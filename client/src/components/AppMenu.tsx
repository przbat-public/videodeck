import { Settings } from 'lucide-react';
import type { JSX } from 'react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ThemeChoice } from '../hooks/useTheme';
import { SUPPORTED_LANGUAGES } from '../i18n';
import type { AppMenuItemSpec } from './appMenuRegistry';
import { useAppMenuSections } from './appMenuRegistry';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui/Menu';

const THEME_CHOICES: { value: ThemeChoice; labelKey: 'theme.system' | 'theme.light' | 'theme.dark' }[] = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

/** One item registered by a page: a plain action or a checkbox toggle */
function RegisteredMenuItem({ item }: { item: AppMenuItemSpec }): JSX.Element {
  if (item.checkbox) {
    return (
      <MenuCheckboxItem
        checked={item.checkbox.checked}
        onCheckedChange={item.checkbox.onCheckedChange}
        {...(item.disabled !== undefined ? { disabled: item.disabled } : {})}
        {...(item.title !== undefined ? { title: item.title } : {})}
      >
        {item.label}
      </MenuCheckboxItem>
    );
  }
  return (
    <MenuItem
      {...(item.active !== undefined ? { active: item.active } : {})}
      {...(item.disabled !== undefined ? { disabled: item.disabled } : {})}
      {...(item.title !== undefined ? { title: item.title } : {})}
      {...(item.onSelect !== undefined ? { onSelect: item.onSelect } : {})}
    >
      {item.label}
    </MenuItem>
  );
}

interface AppMenuProps {
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
}

/**
 * The top bar gear menu: navigation, the route-registered sections and the
 * settings (theme, language). Checked items mark the active choice with the
 * same indicator the Select dropdown uses.
 */
export function AppMenu({ theme, onThemeChange }: AppMenuProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const sections = useAppMenuSections();

  return (
    <Menu>
      <MenuTrigger aria-label={t('menu.label')}>
        <Settings aria-hidden="true" focusable="false" className="ui-menu-gear" />
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>{t('menu.navigation')}</MenuLabel>
        <MenuItem active={pathname === '/'} onSelect={() => navigate('/')}>
          {t('menu.videoList')}
        </MenuItem>
        <MenuItem active={pathname === '/download'} onSelect={() => navigate('/download')}>
          {t('menu.download')}
        </MenuItem>
        {sections.map((section) => (
          <Fragment key={section.key}>
            <MenuSeparator />
            {section.label && <MenuLabel>{section.label}</MenuLabel>}
            {section.items.map((item) => (
              <RegisteredMenuItem key={item.key} item={item} />
            ))}
          </Fragment>
        ))}
        <MenuSeparator />
        <MenuLabel>{t('menu.theme')}</MenuLabel>
        {THEME_CHOICES.map((choice) => (
          <MenuItem key={choice.value} active={theme === choice.value} onSelect={() => onThemeChange(choice.value)}>
            {t(choice.labelKey)}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuLabel>{t('menu.language')}</MenuLabel>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <MenuItem key={lang} active={i18n.resolvedLanguage === lang} onSelect={() => void i18n.changeLanguage(lang)}>
            {lang === 'pl' ? t('menu.polish') : t('menu.english')}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
