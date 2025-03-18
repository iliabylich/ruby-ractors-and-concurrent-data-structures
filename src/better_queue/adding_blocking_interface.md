# Adding Blocking Interface

Now we need to write a function that tries to push (and pop) in a loop until it succeeds.

```rust
impl MpmcQueue {
    pub fn push(&self, data: c_ulong) {
        loop {
            if self.try_push(data) {
                return;
            }
        }
    }

    pub fn pop(&self) -> c_ulong {
        loop {
            if let Some(data) = self.try_pop() {
                return data;
            }
        }
    }
}
```

There's only one problem: busy-looping. We can't use the same approach with spinning that we had in a `SpinLock`.

> "Busy-looping" means that our loop burns CPU while spinning. It's fine in some cases but if we write a queue for a web server then we definitely don't want it to burn all CPU cores if no requests are coming.

There are different solutions to avoid it (like `FUTEX_WAIT` sycall on Linux) but here we'll use [POSIX semaphores](https://man7.org/linux/man-pages/man7/sem_overview.7.html). I haven't compared it to other solutions, so there's a chance that it's terribly slow. I have an excuse though: semaphores are relatively easy to understand.

Right now we need 3 functions:

1. `sem_init` - initializes a semaphore object, in our case must be called as `sem_init(ptr_to_sem_object, 0, initial_value)` where 0 means "shared between threads of the current process, but not with other processes" (yes that's also supported but then semaphore must be located in shared memory).
2. `sem_post` - increments the value of the semaphore by 1, wakes up threads that are waiting for this semaphore
3. `sem_wait` - waits for a semaphore value to be greater than zero and atomically decrements its value. Goes to sleep if the value is zero.
4. `sem_destroy` - self-explanatory

Here's a Rust wrapper for these APIs:

```rust
use libc::{sem_destroy, sem_init, sem_post, sem_t, sem_wait};

pub(crate) struct Semaphore {
    inner: *mut sem_t,
}

impl Semaphore {
    pub(crate) fn alloc() -> Self {
        unsafe { std::mem::zeroed() }
    }

    pub(crate) fn init(&mut self, initial: u32) {
        // sem_t is not movable, so it has to have a fixed address on the heap
        let ptr = Box::into_raw(Box::new(unsafe { std::mem::zeroed() }));

        let res = unsafe { sem_init(ptr, 0, initial) };
        if res != 0 {
            panic!(
                "bug: failed to create semaphore: {:?}",
                std::io::Error::last_os_error()
            )
        }

        self.inner = ptr;
    }

    pub(crate) fn post(&self) {
        let res = unsafe { sem_post(self.inner) };
        if res != 0 {
            panic!(
                "bug: failed to post to semaphore: {:?}",
                std::io::Error::last_os_error()
            )
        }
    }

    pub(crate) fn wait(&self) {
        let res = unsafe { sem_wait(self.inner) };
        if res != 0 {
            panic!(
                "bug: failed to wait for semaphore: {:?}",
                std::io::Error::last_os_error()
            )
        }
    }
}

impl Drop for Semaphore {
    fn drop(&mut self) {
        unsafe {
            sem_destroy(self.inner);
            drop(Box::from_raw(self.inner));
        }
    }
}

unsafe impl Send for Semaphore {}
unsafe impl Sync for Semaphore {}
```

Now we can add two semaphores to our struct:

```rust
struct MpmcQueue {
    // ...

    // Semaphore for readers, equal to the number of elements that can be pop-ed
    read_sem: Semaphore,

    // Semaphore for writers, equal to the number of elements that can be push-ed
    // (i.e. a number of free slots in the queue)
    write_sem: Semaphore,
}

impl MpmcQueue {
    fn alloc() {
        MpmcQueue {
            // ...
            read_sem: Semaphore::alloc(),
            write_sem: Semaphore::alloc(),
        }
    }

    fn init(&mut self, buffer_size: usize, default: c_ulong) {
        // ...

        // Initially 0 elements can be pop-ed
        self.read_sem.init(0);

        // And `buffer_size` elements can be pushed
        self.write_sem.init(buffer_size as u32);
    }

    fn try_push(&self, data: c_ulong) -> bool {
        // ...

        // Wake up one waiting reader, there's at least one element in the queue
        self.read_sem.post();
        true
    }

    fn try_pop(&self) -> Option<c_ulong> {
        // ...

        // Wake up one waiting writer, there's at least one empty slot
        self.write_sem.post();
        Some(data)
    }
}
```

And finally we can add `.push` and `.pop` methods that go to sleep if they can't proceed:

```rust
pub fn push(&self, data: c_ulong) {
    loop {
        if self.try_push(data) {
            return;
        }
        self.write_sem.wait();
    }
}

pub fn pop(&self) -> c_ulong {
    loop {
        if let Some(data) = self.try_pop() {
            return data;
        }
        self.read_sem.wait();
    }
}
```

Now if you call `.push` on an full queue it doesn't burn CPU, same with calling `.pop` on an empty queue.
