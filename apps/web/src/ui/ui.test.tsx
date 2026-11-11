import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderOpen, LayoutGrid, List, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  Avatar,
  Button,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  initials,
  isApplePlatform,
  Kbd,
  LoadingRegion,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toaster,
  ToggleGroup,
  toast,
} from './index.ts';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

test('buttons: loading disables and announces; asChild renders a link', () => {
  render(<Button loading>Save</Button>);
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Loading');

  render(
    <Button asChild>
      <a href="/x">Go</a>
    </Button>,
  );
  expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/x');
});

test('buttons default to type="button" so they never submit a form by accident', () => {
  render(<Button>Plain</Button>);
  expect(screen.getByRole('button', { name: 'Plain' })).toHaveAttribute('type', 'button');
});

test('icon buttons are named by their label, shown as a tooltip on focus', async () => {
  const user = userEvent.setup();
  render(<IconButton label="Close sidebar" icon={<X />} />);
  const button = screen.getByRole('button', { name: 'Close sidebar' });
  await user.tab();
  expect(button).toHaveFocus();
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Close sidebar');
});

test('icon buttons show their shortcut and can skip the tooltip', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<IconButton label="Search" icon={<X />} shortcut={['mod', 'k']} />);
  const search = screen.getByRole('button', { name: 'Search' });
  expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  await user.tab();
  const tooltip = await screen.findByRole('tooltip');
  expect(tooltip).toHaveTextContent('Search');
  expect(tooltip).toHaveTextContent('Ctrl');
  unmount();

  render(<IconButton label="Close" icon={<X />} tooltip={false} />);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

test('field wires label, description and error', () => {
  const { rerender } = render(
    <Field label="Name" description="Shown on the project page." error="Required">
      {(control) => <Input {...control} />}
    </Field>,
  );
  const input = screen.getByLabelText('Name');
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Required');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  expect(input).toHaveAccessibleDescription(/Shown on the project page\./);

  rerender(
    <Field label="Name" optional>
      {(control) => <Input {...control} />}
    </Field>,
  );
  expect(screen.getByLabelText(/Name/)).not.toHaveAttribute('aria-invalid');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Optional')).toBeInTheDocument();
});

function DialogHarness({ dismissible }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Rename</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Rename project"
        {...(dismissible === undefined ? {} : { dismissible })}
        footer={<Button onClick={() => setOpen(false)}>Save</Button>}
      >
        <Input aria-label="Project name" />
      </Dialog>
    </>
  );
}

test('dialog traps focus, closes on Escape and returns focus to the trigger', async () => {
  const user = userEvent.setup();
  render(<DialogHarness />);
  const trigger = screen.getByRole('button', { name: 'Rename' });
  await user.click(trigger);

  const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
  expect(within(dialog).getByRole('textbox', { name: 'Project name' })).toHaveFocus();
  for (let step = 0; step < 4; step += 1) {
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  }
  await user.tab({ shift: true });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

function SafeChoiceDialog() {
  const safe = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={() => {}}
      title="Hidden files"
      initialFocus={safe}
      footer={
        <>
          <Button variant="secondary">Include them</Button>
          <Button ref={safe}>Skip hidden files</Button>
        </>
      }
    />
  );
}

test('a dialog opens with focus on the element it names, not the first one', async () => {
  render(<SafeChoiceDialog />);
  const dialog = await screen.findByRole('dialog', { name: 'Hidden files' });
  expect(within(dialog).getByRole('button', { name: 'Skip hidden files' })).toHaveFocus();
});

test('dialog has a labelled close button', async () => {
  const user = userEvent.setup();
  render(<DialogHarness />);
  await user.click(screen.getByRole('button', { name: 'Rename' }));
  await user.click(await screen.findByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

/** The backdrop: the dialog's overlay, which wraps the panel. */
const backdropOf = (dialog: HTMLElement) => dialog.parentElement as HTMLElement;

test('dialog closes on a backdrop click by default', async () => {
  const user = userEvent.setup();
  render(<DialogHarness />);
  await user.click(screen.getByRole('button', { name: 'Rename' }));
  await user.click(backdropOf(await screen.findByRole('dialog', { name: 'Rename project' })));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('a dialog that refuses dismissal ignores Escape and the backdrop', async () => {
  const user = userEvent.setup();
  render(<DialogHarness dismissible={false} />);
  await user.click(screen.getByRole('button', { name: 'Rename' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename project' });

  await user.keyboard('{Escape}');
  await user.click(backdropOf(dialog));
  expect(screen.getByRole('dialog', { name: 'Rename project' })).toBeInTheDocument();

  // Its own buttons still close it.
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('confirm dialog runs onConfirm once and keeps open with the error', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn(() => Promise.reject(new Error('Nope')));
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete project?"
      body="Its artifacts are deleted too."
      confirmLabel="Delete"
      tone="danger"
      onConfirm={onConfirm}
    />,
  );
  await user.dblClick(screen.getByRole('button', { name: 'Delete' }));

  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Nope')).toBeInTheDocument();
  expect(screen.getByRole('alertdialog', { name: 'Delete project?' })).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test('confirm dialog closes after onConfirm resolves and maps errors', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const { rerender } = render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Revoke token?"
      body="Agents using it stop working."
      confirmLabel="Revoke"
      onConfirm={() => Promise.resolve()}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

  rerender(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Revoke token?"
      body="Agents using it stop working."
      confirmLabel="Revoke"
      onConfirm={() => Promise.reject('offline')}
      errorMessage={(error) => `Could not revoke: ${String(error)}`}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(await screen.findByText('Could not revoke: offline')).toBeInTheDocument();
});

test('menu opens from the keyboard and moves with arrows', async () => {
  const user = userEvent.setup();
  render(
    <Menu>
      <MenuTrigger asChild>
        <Button>Actions</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem>Rename</MenuItem>
        <MenuItem tone="danger">Delete</MenuItem>
      </MenuContent>
    </Menu>,
  );
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard('{Enter}');

  const menu = await screen.findByRole('menu');
  const items = within(menu).getAllByRole('menuitem');
  await waitFor(() => expect(items[0]).toHaveFocus());
  await user.keyboard('{ArrowDown}');
  expect(items[1]).toHaveFocus();

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

test('tabs move with arrow keys', async () => {
  const user = userEvent.setup();
  render(
    <Tabs defaultValue="profile">
      <TabsList aria-label="Settings sections">
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="tokens">API tokens</TabsTrigger>
      </TabsList>
      <TabsContent value="profile">Profile panel</TabsContent>
      <TabsContent value="tokens">Tokens panel</TabsContent>
    </Tabs>,
  );
  await user.tab();
  expect(screen.getByRole('tab', { name: 'Profile' })).toHaveFocus();
  await user.keyboard('{ArrowRight}');

  const tokens = screen.getByRole('tab', { name: 'API tokens' });
  expect(tokens).toHaveFocus();
  expect(tokens).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Tokens panel');
});

test('toggle group is single-select with named items', async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <ToggleGroup
      label="View"
      value="grid"
      onValueChange={onValueChange}
      items={[
        { value: 'grid', label: 'Grid', icon: <LayoutGrid /> },
        { value: 'list', label: 'List', icon: <List /> },
      ]}
    />,
  );
  const group = screen.getByRole('radiogroup', { name: 'View' });
  const grid = within(group).getByRole('radio', { name: 'Grid' });
  expect(grid).toHaveAttribute('aria-checked', 'true');
  expect(within(group).getByRole('radio', { name: 'List' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  await user.click(within(group).getByRole('radio', { name: 'List' }));
  expect(onValueChange).toHaveBeenCalledWith('list');

  // Pressing the active item again must not clear the selection.
  await user.click(grid);
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

test('select is labelled and picks an option', async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <Select
      label="Role"
      value="member"
      onValueChange={onValueChange}
      options={[
        { value: 'member', label: 'Member' },
        { value: 'admin', label: 'Admin' },
      ]}
    />,
  );
  const trigger = screen.getByRole('combobox', { name: 'Role' });
  expect(trigger).toHaveTextContent('Member');
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: 'Admin' }));
  expect(onValueChange).toHaveBeenCalledWith('admin');
});

test('toasts appear in a labelled notifications region', async () => {
  render(<Toaster />);
  act(() => {
    toast.success('Project created', { description: 'Happy Booth is ready.' });
  });
  expect(await screen.findByText('Project created')).toBeInTheDocument();
  expect(screen.getByText('Happy Booth is ready.')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /Notifications/ })).toBeInTheDocument();
});

test('loading region announces', () => {
  const { container } = render(
    <LoadingRegion label="Loading projects">
      <Skeleton className="h-8" />
    </LoadingRegion>,
  );
  expect(screen.getByRole('status', { name: 'Loading projects' })).toBeInTheDocument();
  expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
});

test('empty and error states render their actions', async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn();
  render(
    <>
      <EmptyState
        icon={<FolderOpen />}
        title="No projects yet"
        description="Projects group the artifacts your agents publish."
        action={<Button>New project</Button>}
      />
      <ErrorState message="Pinwall could not be reached." onRetry={onRetry} />
    </>,
  );
  expect(screen.getByText('No projects yet')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Something went wrong');
  expect(alert).toHaveTextContent('Pinwall could not be reached.');
  await user.click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('initials', () => {
  expect(initials('Ada Lovelace')).toBe('AL');
  expect(initials('đức')).toBe('Đ');
  expect(initials('  ')).toBe('?');
  expect(initials('😀 smile')).toBe('😀S');
  expect(initials('Nguyễn Văn An')).toBe('NA');
});

test('avatar shows initials on a stable hue', () => {
  const { container, rerender } = render(<Avatar name="Ada Lovelace" />);
  const first = container.firstElementChild;
  expect(first).toHaveTextContent('AL');
  expect(first).toHaveAttribute('aria-hidden', 'true');
  const hue = first?.className;
  rerender(<Avatar name="Ada Lovelace" />);
  expect(container.firstElementChild?.className).toBe(hue);
});

test('kbd shows ⌘ on Apple platforms and Ctrl elsewhere', () => {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  expect(isApplePlatform()).toBe(true);
  const { unmount } = render(<Kbd keys={['mod', 'enter']} />);
  expect(screen.getByText('⌘')).toBeInTheDocument();
  expect(screen.getByText('↵')).toBeInTheDocument();
  unmount();

  platform.mockReturnValue('Win32');
  expect(isApplePlatform()).toBe(false);
  render(<Kbd keys={['mod', 'k']} />);
  expect(screen.getByText('Ctrl')).toBeInTheDocument();
  expect(screen.getByText('K')).toBeInTheDocument();
});

test('copy field copies with the Clipboard API and without it', async () => {
  const user = userEvent.setup();
  const value = 'pw_live_3f9a';

  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const first = render(<CopyField label="API token" value={value} mono />);
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith(value);
  expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  first.unmount();

  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  const second = render(<CopyField label="API token" value={value} />);
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(execCommand).toHaveBeenCalledWith('copy');
  expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  second.unmount();

  execCommand.mockReturnValue(false);
  render(<CopyField label="MCP config" value={'{\n  "url": "x"\n}'} multiline />);
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  const field = screen.getByLabelText('MCP config') as HTMLTextAreaElement;
  await waitFor(() => expect(field).toHaveFocus());
  expect(field.selectionStart).toBe(0);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(screen.getByRole('status')).toHaveTextContent('Press Ctrl+C to copy.');
});
