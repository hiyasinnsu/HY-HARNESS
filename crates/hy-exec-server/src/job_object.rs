//! Minimal Job Object wrapper (design §4.3).
//!
//! One Job Object per command. `KILL_ON_JOB_CLOSE` makes a crash of the daemon
//! take the whole process tree with it; `terminate` is used for `job/kill` and
//! for rolling back a run. If the process is already in a job (CI runners do
//! this), assignment fails with access denied; callers fall back to `taskkill`.

#![cfg(windows)]

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};

pub struct JobHandle {
    handle: HANDLE,
}

// A Job Object handle is process-wide and may be used from any thread.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    pub fn new() -> io::Result<Self> {
        // SAFETY: null attributes and name are valid.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self { handle };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is a correctly sized, initialized struct.
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Assigns an already-created child. Returns the OS error when the process
    /// is already in a non-breakaway job.
    pub fn assign(&self, child: &tokio::process::Child) -> io::Result<()> {
        let Some(handle) = child.raw_handle() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "child has already been reaped",
            ));
        };
        // SAFETY: the child handle is valid for the lifetime of `child`.
        let ok = unsafe { AssignProcessToJobObject(self.handle, handle as HANDLE) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Caps the number of live processes (the PTC worker: 1, so it cannot spawn).
    pub fn limit_active_processes(&self, n: u32) -> io::Result<()> {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = n;
        // SAFETY: `info` is a correctly sized, initialized struct.
        let ok = unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// The raw handle, for `PROC_THREAD_ATTRIBUTE_JOB_LIST` (confined spawns).
    pub fn raw(&self) -> HANDLE {
        self.handle
    }

    pub fn terminate(&self) {
        // SAFETY: the handle is valid until Drop.
        unsafe {
            TerminateJobObject(self.handle, 1);
        }
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // SAFETY: `handle` was created by CreateJobObjectW and is owned here.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
