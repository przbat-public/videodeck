import { Settings } from 'lucide-react';
import type { JSX } from 'react';
import { Fragment, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ThemeChoice } from '../hooks/useTheme';
import { SUPPORTED_LANGUAGES } from '../i18n';
import type { AppMenuItemSpec } from './appMenuRegistry';
import { useAppMenuSections } from './appMenuRegistry';
import { Button } from './ui/Button';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui/Menu';
import { Modal } from './ui/Modal';

const THEME_CHOICES: { value: ThemeChoice; labelKey: 'theme.system' | 'theme.light' | 'theme.dark' }[] = [
  { value: 'system', labelKey: 'theme.system' },
  { value: 'light', labelKey: 'theme.light' },
  { value: 'dark', labelKey: 'theme.dark' },
];

/**
 * One item registered by a page: a plain action or a checkbox toggle. An
 * item that asks for confirmation hands itself to `onConfirm` instead of
 * running.
 */
function RegisteredMenuItem({
  item,
  onConfirm,
}: {
  item: AppMenuItemSpec;
  onConfirm: (item: AppMenuItemSpec) => void;
}): JSX.Element {
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
  const onSelect = item.confirm !== undefined ? () => onConfirm(item) : item.onSelect;
  return (
    <MenuItem
      {...(item.active !== undefined ? { active: item.active } : {})}
      {...(item.disabled !== undefined ? { disabled: item.disabled } : {})}
      {...(item.title !== undefined ? { title: item.title } : {})}
      {...(onSelect !== undefined ? { onSelect } : {})}
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
  // The item waiting for its confirmation, and the gear it returns focus to:
  // the menu entry that opened the dialog is gone by the time it closes
  const [confirming, setConfirming] = useState<AppMenuItemSpec | null>(null);
  const [gear, setGear] = useState<HTMLButtonElement | null>(null);
  // Set when the confirmation is asked for, before React renders the
  // dialog, so the menu's own close handler already sees it
  const confirmRequestedRef = useRef(false);

  const askToConfirm = (item: AppMenuItemSpec): void => {
    confirmRequestedRef.current = true;
    setConfirming(item);
  };
  const closeConfirmation = (): void => {
    confirmRequestedRef.current = false;
    setConfirming(null);
  };

  return (
    <>
      <Menu>
        <MenuTrigger ref={setGear} aria-label={t('menu.label')}>
          <Settings aria-hidden="true" focusable="false" className="ui-menu-gear" />
        </MenuTrigger>
        <MenuContent
          onCloseAutoFocus={(event) => {
            // The dialog takes the focus next. Radix moving it back to the gear
            // after the dialog opened would put it behind the modal.
            if (confirmRequestedRef.current) {
              event.preventDefault();
            }
          }}
        >
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
                <RegisteredMenuItem key={item.key} item={item} onConfirm={askToConfirm} />
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
            <MenuItem
              key={lang}
              active={i18n.resolvedLanguage === lang}
              onSelect={() => void i18n.changeLanguage(lang)}
            >
              {lang === 'pl' ? t('menu.polish') : t('menu.english')}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {confirming?.confirm && (
        <Modal title={confirming.confirm.title} onClose={closeConfirmation} returnFocus={gear}>
          <p className="ui-modal-message">{confirming.confirm.message}</p>
          <div className="ui-modal-actions">
            {/* First in the dialog, so the browser gives it the focus */}
            <Button onClick={closeConfirmation}>{t('app.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                closeConfirmation();
                confirming.onSelect?.();
              }}
            >
              {confirming.confirm.confirmLabel}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
