import { App, Modal, Setting } from 'obsidian';
import { t } from '../i18n';

interface EncryptionModalOptions {
	folder: string;
	unlock?: boolean;
	remember?: boolean;
	onClose?(): void;
	destination(folder: string): string;
	submit(folder: string, password: string, remember: boolean, create: boolean): Promise<void>;
}

export class EncryptionModal extends Modal {
	constructor(
		app: App,
		private options: EncryptionModalOptions
	) {
		super(app);
	}
	onOpen(): void {
		let folder = this.options.folder,
			password = '',
			confirmation = '',
			remember = this.options.remember ?? true,
			create = !this.options.unlock;
		this.setTitle(t(this.options.unlock ? 'encryption.unlock' : 'encryption.heading'));
		this.contentEl.createEl('p', { text: t('encryption.description') });
		let confirmSetting: Setting | undefined;
		if (!this.options.unlock)
			new Setting(this.contentEl).setName(t('encryption.operation')).addDropdown((dropdown) =>
				dropdown
					.addOption('create', t('encryption.create'))
					.addOption('connect', t('encryption.connect'))
					.onChange((value) => {
						create = value === 'create';
						confirmSetting?.settingEl.toggle(create);
					})
			);
		const destination = this.contentEl.createEl('p', {
			text: this.options.destination(folder),
			cls: 'onedrive-encryption-destination',
		});
		if (!this.options.unlock)
			new Setting(this.contentEl).setName(t('encryption.folder')).addText((input) =>
				input.setValue(folder).onChange((value) => {
					folder = value;
					destination.setText(this.options.destination(folder));
				})
			);
		new Setting(this.contentEl).setName(t('encryption.password')).addText((input) => {
			input.inputEl.type = 'password';
			input.inputEl.autocomplete = 'off';
			input.onChange((value) => {
				password = value;
			});
		});
		if (!this.options.unlock)
			confirmSetting = new Setting(this.contentEl)
				.setName(t('encryption.confirmPassword'))
				.addText((input) => {
					input.inputEl.type = 'password';
					input.inputEl.autocomplete = 'off';
					input.onChange((value) => {
						confirmation = value;
					});
				});
		new Setting(this.contentEl)
			.setName(t('encryption.remember'))
			.setDesc(t('encryption.rememberDescription'))
			.addToggle((toggle) =>
				toggle.setValue(remember).onChange((value) => {
					remember = value;
				})
			);
		if (!this.options.unlock)
			this.contentEl.createEl('p', { text: t('encryption.previousCopies') });
		const errorEl = this.contentEl.createEl('p', { cls: 'mod-warning' });
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText(t(this.options.unlock ? 'encryption.unlock' : 'encryption.start'))
				.setCta()
				.onClick(async () => {
					if (
						!password ||
						(create && password.normalize('NFC') !== confirmation.normalize('NFC'))
					) {
						errorEl.setText(t('encryption.passwordMismatch'));
						return;
					}
					button.setDisabled(true);
					errorEl.setText(t('encryption.working'));
					try {
						await this.options.submit(folder, password, remember, create);
						password = '';
						confirmation = '';
						this.close();
					} catch (error) {
						errorEl.setText(error instanceof Error ? error.message : t('encryption.failed'));
					} finally {
						button.setDisabled(false);
					}
				})
		);
	}
	onClose(): void {
		this.contentEl.empty();
		this.options.onClose?.();
	}
}
