# Lock Free MPMC Queue

> There's one important rule about lock-free data structures: don't write them yourself unless you absolutely know how to do that.
>
> Lock-free data structures are very complex and if you make a mistake you may only find it on a different hardware, or when it's used with a different pattern.
>
> Just use existing libraries, there's a plenty of them in C/C++/Rust worlds.

Here I'm porting [this C++ implementation](https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) to Rust, mostly to show what happens inside. If I had a chance to use existing Rust package I'd do that without thinking even for a second.

```rust
// This is a wrapper of a single element of the queue
struct QueueElement {
    sequence: AtomicUsize,
    data: Cell<c_ulong>,
}
unsafe impl Send for QueueElement {}
unsafe impl Sync for QueueElement {}

struct MpmcQueue {
    buffer: Vec<QueueElement>,
    buffer_mask: usize,
    enqueue_pos: AtomicUsize,
    dequeue_pos: AtomicUsize,
}

impl MpmcQueue {
    fn alloc() -> Self {
        Self {
            buffer: vec![],
            buffer_mask: 0,
            enqueue_pos: AtomicUsize::new(0),
            dequeue_pos: AtomicUsize::new(0),
        }
    }

    fn init(&mut self, buffer_size: usize, default: c_ulong) {
        assert!(buffer_size >= 2);
        assert_eq!(buffer_size & (buffer_size - 1), 0);

        let mut buffer = Vec::with_capacity(buffer_size);
        for i in 0..buffer_size {
            buffer.push(QueueElement {
                sequence: AtomicUsize::new(i),
                data: Cell::new(default),
            });
        }

        self.buffer_mask = buffer_size - 1;
        self.buffer = buffer;
        self.enqueue_pos.store(0, Ordering::Relaxed);
        self.dequeue_pos.store(0, Ordering::Relaxed);
    }

    fn try_push(&self, data: c_ulong) -> bool {
        let mut cell;
        let mut pos = self.enqueue_pos.load(Ordering::Relaxed);
        loop {
            cell = &self.buffer[pos & self.buffer_mask];
            let seq = cell.sequence.load(Ordering::Acquire);
            let diff = seq as isize - pos as isize;
            if diff == 0 {
                if self
                    .enqueue_pos
                    .compare_exchange_weak(pos, pos + 1, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
                {
                    break;
                }
            } else if diff < 0 {
                return false;
            } else {
                pos = self.enqueue_pos.load(Ordering::Relaxed);
            }
        }
        cell.data.set(data);
        cell.sequence.store(pos + 1, Ordering::Release);
        true
    }

    fn try_pop(&self) -> Option<c_ulong> {
        let mut cell;
        let mut pos = self.dequeue_pos.load(Ordering::Relaxed);
        loop {
            cell = &self.buffer[pos & self.buffer_mask];
            let seq = cell.sequence.load(Ordering::Acquire);
            let diff = seq as isize - (pos + 1) as isize;
            if diff == 0 {
                if self
                    .dequeue_pos
                    .compare_exchange_weak(pos, pos + 1, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
                {
                    break;
                }
            } else if diff < 0 {
                return None;
            } else {
                pos = self.dequeue_pos.load(Ordering::Relaxed);
            }
        }

        let data = cell.data.get();
        cell.sequence
            .store(pos + self.buffer_mask + 1, Ordering::Release);

        Some(data)
    }
}
```

Here we have a struct that contains N elements and two atomic indexes. The first index for reading, the second is for writing. Basically it's an atomic version of the ["ring buffer"](https://en.wikipedia.org/wiki/Circular_buffer). When we push we shift "write" index to the right, when we pop we shift "read" index to the right.

On top that each cell of the queue has a field called `sequence` that is used to make sure that a `push` that we are trying to do in a loop happens in sync with bumping a "write" pointer (same for `pop`-ing).

Additionally, there's an assertion at the beginning of the constructor that only accepts `buffer_size` that is a power of two. Why is it needed? Well, `buffer_mask` that is derived from it is the answer.

Let's say our `buffer_size` is set to 8 (`0b1000`), then `buffer_mask` becomes 7 (`0b111`). If we use bit-and on a monotonically increasing number with this mask we'll get a sequence of number in 0-7 range that wraps on overflow. You can try it yourself in REPL by running `0.upto(50).map { |n| n & 0b111 }` - this returns a cycling sequence from 0 to 7.

That's a clever trick to avoid checking for read/write pointer overflows.

> Could I write this code from scratch just by myself? Definitely no. Use existing implementations.
