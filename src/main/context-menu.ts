import { app, Menu, type MenuItemConstructorOptions } from 'electron';

// Electron windows have no right-click menu by default. Give text fields the
// usual edit menu, and selected text a Copy item, in every app window.
export function installContextMenu(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_e, params) => {
      const { editFlags, isEditable, selectionText } = params;
      let template: MenuItemConstructorOptions[];
      if (isEditable) {
        template = [
          { role: 'undo', enabled: editFlags.canUndo },
          { role: 'redo', enabled: editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: editFlags.canSelectAll },
        ];
      } else if (selectionText.trim()) {
        template = [{ role: 'copy' }];
      } else return;
      Menu.buildFromTemplate(template).popup();
    });
  });
}
