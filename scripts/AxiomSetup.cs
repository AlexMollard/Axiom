using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class AxiomSetup
{
    private static readonly Assembly Bundle = typeof(AxiomSetup).Assembly;
    private static readonly Version Target = Bundle.GetName().Version;
    private static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AxiomDesktop");
    private static readonly string App = Path.Combine(Root, "current", "axiom.exe");

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    [STAThread]
    private static int Main(string[] args)
    {
        // Preserve Velopack's command-line contract, including --silent and --installto.
        if (args.Length != 0)
        {
            try { return RunVelopack(string.Join(" ", args.Select(Quote))); }
            catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
        }

        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { return ShowSetup(); }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Axiom Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static Version InstalledVersion()
    {
        if (File.Exists(App))
        {
            Version version;
            if (Version.TryParse(FileVersionInfo.GetVersionInfo(App).ProductVersion, out version))
                return new Version(version.Major, version.Minor, Math.Max(0, version.Build));
        }
        if (!Directory.Exists(Root) || !Directory.EnumerateFileSystemEntries(Root).Any()) return null;
        throw new InvalidOperationException("Setup could not identify the existing Axiom installation. No files were changed.");
    }

    private static int ShowSetup()
    {
        var installed = InstalledVersion();
        var target = new Version(Target.Major, Target.Minor, Target.Build);
        string action = installed == null ? "Install" : installed < target ? "Update" : installed == target ? "Repair" : "Downgrade";
        string summary = installed == null ? "Version " + target + " · This Windows account"
            : installed == target ? "Reinstall version " + target
            : "Installed: " + installed + "   ·   Setup: " + target;
        bool contrast = SystemInformation.HighContrast;
        var background = contrast ? SystemColors.Window : Color.FromArgb(24, 23, 22);
        var foreground = contrast ? SystemColors.WindowText : Color.FromArgb(241, 233, 227);
        var muted = contrast ? foreground : Color.FromArgb(191, 176, 167);
        var accent = contrast ? SystemColors.Highlight : Color.FromArgb(211, 148, 118);
        var onAccent = contrast ? SystemColors.HighlightText : Color.FromArgb(35, 24, 18);
        int result = 0;
        bool running = false;

        using (var form = new Form())
        using (var icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath))
        using (var emblemStream = Bundle.GetManifestResourceStream("Axiom.Emblem"))
        using (var emblem = Image.FromStream(emblemStream))
        using (var titleFont = new Font("Segoe UI", 19, FontStyle.Bold))
        using (var uiFont = new Font("Segoe UI", 10))
        using (var timer = new Timer { Interval = 30 })
        {
            form.Text = "Axiom Setup";
            form.Icon = icon;
            form.Font = uiFont;
            form.AutoScaleDimensions = new SizeF(96, 96);
            form.AutoScaleMode = AutoScaleMode.Dpi;
            form.AutoSize = true;
            form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.BackColor = background;
            form.ForeColor = foreground;
            if (!contrast) form.HandleCreated += delegate { int dark = 1; DwmSetWindowAttribute(form.Handle, 20, ref dark, 4); };

            var picture = new PictureBox { Size = new Size(64, 64), Margin = new Padding(0, 0, 14, 0), Image = emblem, SizeMode = PictureBoxSizeMode.Zoom };
            var heading = new Label { AutoSize = true, MaximumSize = new Size(350, 0), Margin = new Padding(0), Font = titleFont, Text = action + " Axiom" };
            var version = new Label { AutoSize = true, MaximumSize = new Size(350, 0), Margin = new Padding(0, 4, 0, 0), ForeColor = muted, Text = summary };
            var message = new Label {
                AutoSize = true, MaximumSize = new Size(428, 0), Margin = new Padding(0, 16, 0, 18), ForeColor = muted,
                Text = action == "Downgrade" ? "This replaces Axiom with an older version. Only continue if you intend to downgrade."
                    : "Setup replaces app files only. Your vault and settings stay in place."
            };
            int progressOffset = 0;
            var progress = new Panel {
                Visible = false, Anchor = AnchorStyles.Left | AnchorStyles.Right, Size = new Size(0, 6),
                Margin = new Padding(0, 0, 0, 14), BackColor = contrast ? SystemColors.Control : Color.FromArgb(56, 40, 32),
                AccessibleName = "Installation in progress", AccessibleRole = AccessibleRole.ProgressBar
            };
            timer.Tick += delegate {
                progressOffset = (progressOffset + 5) % Math.Max(1, progress.Width + progress.Width / 3);
                progress.Invalidate();
            };
            progress.Paint += delegate(object sender, PaintEventArgs e) {
                int width = Math.Max(1, progress.Width / 3);
                using (var brush = new SolidBrush(accent))
                    e.Graphics.FillRectangle(brush, progressOffset - width, 0, width, progress.Height);
            };
            var primary = MakeButton(action, accent, onAccent, accent);
            var cancel = MakeButton("Cancel", contrast ? SystemColors.Control : Color.FromArgb(41, 38, 36), foreground,
                contrast ? SystemColors.WindowText : Color.FromArgb(108, 89, 78));
            cancel.DialogResult = DialogResult.Cancel;
            cancel.TabIndex = 1;
            primary.TabIndex = 0;
            var details = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = new Padding(0) };
            details.Controls.AddRange(new Control[] { heading, version });
            var header = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Margin = new Padding(0) };
            header.Controls.AddRange(new Control[] { picture, details });
            var buttons = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Margin = new Padding(0), Anchor = AnchorStyles.Right };
            buttons.Controls.AddRange(new Control[] { cancel, primary });
            var layout = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 4, Padding = new Padding(24), Margin = new Padding(0) };
            layout.Controls.Add(header, 0, 0);
            layout.Controls.Add(message, 0, 1);
            layout.Controls.Add(progress, 0, 2);
            layout.Controls.Add(buttons, 0, 3);
            form.Controls.Add(layout);
            form.AcceptButton = action == "Downgrade" ? cancel : primary;
            form.CancelButton = cancel;
            form.ActiveControl = action == "Downgrade" ? cancel : primary;
            form.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (running) e.Cancel = true; };
            primary.Click += async delegate {
                running = true;
                buttons.Visible = false;
                heading.Text = action == "Update" ? "Updating Axiom" : action == "Repair" ? "Repairing Axiom" : "Installing Axiom";
                message.Text = "Setup is replacing app files. Axiom will open when it finishes.";
                form.UseWaitCursor = true;
                progress.Visible = true;
                timer.Start();
                try
                {
                    await Task.Run(() => {
                        if (!Equals(installed, InstalledVersion()))
                            throw new InvalidOperationException("The installed version changed. Close and reopen setup.");
                        int exitCode = RunVelopack("--silent");
                        if (exitCode != 0) throw new InvalidOperationException("Velopack setup exited with code " + exitCode + ".");
                        if (InstalledVersion() != target) throw new InvalidOperationException("Setup did not install version " + target + ".");
                    });
                    var start = new ProcessStartInfo(App) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(App) };
                    start.EnvironmentVariables["VELOPACK_FIRSTRUN"] = "1";
                    using (Process.Start(start)) { }
                    result = 0;
                    running = false;
                    form.Close();
                }
                catch (Exception ex)
                {
                    result = 1;
                    running = false;
                    timer.Stop();
                    progress.Visible = false;
                    form.UseWaitCursor = false;
                    heading.Text = "Could not finish setup";
                    message.Text = ex.Message;
                    cancel.Text = "Close";
                    primary.Visible = false;
                    buttons.Visible = true;
                    cancel.Focus();
                }
            };
            form.ShowDialog();
        }
        return result;
    }

    private static Button MakeButton(string text, Color fill, Color ink, Color border)
    {
        var button = new Button {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(118, 38), Text = text,
            FlatStyle = FlatStyle.Flat, BackColor = fill, ForeColor = ink, UseVisualStyleBackColor = false
        };
        button.FlatAppearance.BorderColor = border;
        button.FlatAppearance.MouseOverBackColor = SystemInformation.HighContrast ? fill : ControlPaint.Light(fill, .18f);
        return button;
    }

    private static int RunVelopack(string arguments)
    {
        string dir = Path.Combine(Path.GetTempPath(), "AxiomSetup-" + Guid.NewGuid().ToString("N"));
        string exe = Path.Combine(dir, "Velopack-Setup.exe");
        Directory.CreateDirectory(dir);
        try
        {
            using (var payload = Bundle.GetManifestResourceStream("Axiom.VelopackSetup"))
            using (var file = new FileStream(exe, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                payload.CopyTo(file);
            using (var process = Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = false, WorkingDirectory = dir }))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        finally
        {
            try { File.Delete(exe); Directory.Delete(dir); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static string Quote(string value)
    {
        return "\"" + Regex.Replace(value, "(\\\\*)(\"|$)", "$1$1$2")
            .Replace("\"", "\\\"") + "\"";
    }
}
