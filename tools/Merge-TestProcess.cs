// Windows-only npm-test containment for Run-Merge.ps1. Compatible with Add-Type on PS 5.1/7.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MergeTestProcess
{
    public sealed class Result
    {
        public int ExitCode = -1;
        public string Failure = "";
        public string Stdout = "";
        public string Stderr = "";
    }

    const int CleanupMs = 3000;
    const int ExitGraceMs = 1000;
    const uint WaitTimeout = 258;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);

    public static Result Run(string directory, int timeoutMs)
    {
        var result = new Result();
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
        var process = new ProcessInformation();
        string stdoutPath = null, stderrPath = null;
        bool attributesReady = false, assigned = false, empty = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "create job");
            var limits = new ExtendedLimits();
            // No breakaway flags. The unnamed, non-inheritable job belongs only to this invocation.
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "set job limits");

            // Files cannot fill an output pipe or wait for EOF from an orphan. Read only after
            // the job is empty; inherited write handles never become a completion signal.
            stdoutPath = Path.GetTempFileName();
            stderrPath = Path.GetTempFileName();
            var security = new SecurityAttributes();
            security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.Inherit = true;
            output = CreateFile(stdoutPath, 0x40000000, 1, ref security, 2, 0x80, IntPtr.Zero);
            Check(output != InvalidHandle, "open stdout");
            error = CreateFile(stderrPath, 0x40000000, 1, ref security, 2, 0x80, IntPtr.Zero);
            Check(error != InvalidHandle, "open stderr");
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            Check(input != InvalidHandle, "open stdin");

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            Check(size != IntPtr.Zero, "size handle list");
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "initialize handle list");
            attributesReady = true;
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "restrict inherited handles");
            var startup = new StartupInfoEx();
            startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Info.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Info.Input = input; startup.Info.Output = output; startup.Info.Error = error;
            startup.Attributes = attributes;
            string cmd = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            Check(CreateProcess(cmd, new StringBuilder("\"" + cmd + "\" /c npm test"), IntPtr.Zero,
                IntPtr.Zero, true, 0x08080004, IntPtr.Zero, directory, ref startup, out process), "create suspended npm");
            // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW:
            // not one instruction of npm (or any child) can run before assignment succeeds.
            Check(AssignProcessToJobObject(job, process.Process), "assign suspended npm to job");
            assigned = true;
            Check(ResumeThread(process.Thread) == 1, "resume contained npm");
            Close(ref input, result); Close(ref output, result); Close(ref error, result);

            uint wait = WaitForSingleObject(process.Process, (uint)timeoutMs);
            if (wait == WaitTimeout) result.Failure = "npm test timed out";
            else
            {
                Check(wait == 0, "wait for npm");
                uint exitCode;
                Check(GetExitCodeProcess(process.Process, out exitCode), "read npm exit code");
                result.ExitCode = unchecked((int)exitCode);
                empty = WaitEmpty(job, ExitGraceMs);
                if (!empty) result.Failure = "npm output/process tree incomplete: descendants survived parent exit";
            }
        }
        catch (Exception ex) { Fail(result, ex.Message); }
        finally
        {
            // Every error path is a refusal. A failed termination/query/close cannot become success.
            if (assigned && !empty)
            {
                try
                {
                    Check(TerminateJobObject(job, 1), "terminate test job (cleanup failure)");
                    Check(WaitEmpty(job, CleanupMs), "test job cleanup deadline exceeded");
                    empty = true;
                }
                catch (Exception ex) { Fail(result, ex.Message); }
            }
            else if (!assigned && process.Process != IntPtr.Zero)
            {
                try
                {
                    // Assignment failed while the root was suspended: it has no descendants.
                    Check(TerminateProcess(process.Process, 1), "terminate suspended npm");
                    Check(WaitForSingleObject(process.Process, CleanupMs) == 0, "suspended npm cleanup deadline exceeded");
                }
                catch (Exception ex) { Fail(result, ex.Message); }
            }
            // Kill-on-close is the last bounded fallback, including if TerminateJobObject failed.
            Close(ref job, result);
            Close(ref process.Thread, result); Close(ref process.Process, result);
            Close(ref input, result); Close(ref output, result); Close(ref error, result);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (empty)
            {
                try
                {
                    result.Stdout = File.ReadAllText(stdoutPath);
                    result.Stderr = File.ReadAllText(stderrPath);
                }
                catch (Exception ex) { Fail(result, "read test output: " + ex.Message); }
            }
            foreach (string file in new string[] { stdoutPath, stderrPath })
            {
                try { if (file != null) File.Delete(file); }
                catch (Exception ex) { Fail(result, "remove test output: " + ex.Message); }
            }
        }
        return result;
    }

    static bool WaitEmpty(IntPtr job, int milliseconds)
    {
        var clock = Stopwatch.StartNew();
        do
        {
            Accounting accounting;
            Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "query test job");
            if (accounting.ActiveProcesses == 0) return true;
            Thread.Sleep(10);
        } while (clock.ElapsedMilliseconds < milliseconds);
        return false;
    }
    static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static void Fail(Result result, string message) { result.Failure += (result.Failure.Length == 0 ? "" : "; ") + message; }
    static void Close(ref IntPtr handle, Result result)
    {
        if (handle != IntPtr.Zero && handle != InvalidHandle && !CloseHandle(handle)) Fail(result, "close owned handle failed");
        handle = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo
    {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
    {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
}
