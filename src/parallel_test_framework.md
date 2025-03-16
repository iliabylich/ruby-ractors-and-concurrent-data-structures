# Parallel Test Framework

Its interface is inspired by `minitest` but I'm not going to implement all features, so let's call it `microtest`.

First, we need a `TestCase` class with at least one assertion helper:

```ruby
class Microtest::TestCase
  def assert_eq(lhs, rhs, message = 'assertion failed')
    if lhs != rhs
      raise "#{message}: #{lhs} != #{rhs}"
    end
  end
end
```

Then, there should be a hook that keeps track of all subclasses of our `Microtest::TestCase` class:

```ruby
class Microtest::TestCase
  class << self
    def inherited(subclass)
      subclasses << subclass
    end

    def subclasses
      @subclasses ||= []
    end
  end
end
```

And finally we can write a helper to run an individual test method, measure time taken, record an error and track it on some imaginary `report` object:

```ruby
class Microtest::TestCase
  class << self
    def measure
      start = now
      yield
      now - start
    end

    def run(method_name, report)
      instance = new
      time = measure { instance.send(method_name) }
      print "."
      report.passed!(self, method_name, time)
    rescue => err
      print "F"
      report.failed!(self, method_name, err)
    end
  end
end
```

> No support for custom formatters, no `setup`/`teardown` hooks. We build a micro-framework.

Time to build a `Report` class. I'll paste it as a single snippet because it's completely unrelated to parallel execution:

```ruby
class Microtest::Report
  attr_reader :passed, :failed

  def initialize
    @passed = []
    @failed = []
  end

  def passed!(klass, method_name, time)
    @passed << [klass, method_name, time]
  end

  def failed!(klass, method_name, err)
    @failed << [klass, method_name, err]
  end

  # Why do we need this? Because we'll merge reports produced by multiple Ractors.
  def merge!(other)
    @passed += other.passed
    @failed += other.failed
  end

  def print
    puts "Passed: #{passed.count}"
    passed.each do |klass, method_name, time|
      puts "  - #{klass}##{method_name} (in #{time}ms)"
    end
    puts "Failed: #{failed.count}"
    failed.each do |klass, method_name, err|
      puts "  - #{klass}##{method_name}: #{err}"
    end
  end
end
```

The last part is spawning Ractors and pushing all test methods to a shared queue:

```ruby
class Microtest::TestCase
  class << self
    def test_methods
      instance_methods.grep(/\Atest_/)
    end
  end
end

module Microtest
  QUEUE = CAtomics::QueueWithMutex.new(100)

  # yes, this is not portable, but it works on my machine
  CPU_COUNT = `cat /proc/cpuinfo | grep processor | wc -l`.to_i
  puts "CPU count: #{CPU_COUNT}"

  def self.run!
    # First, spawn worker per core
    workers = 1.upto(CPU_COUNT).map do |i|
      Ractor.new(name: "worker-#{i}") do
        # inside allocate a per-Ractor report
        report = Report.new

        # and just run every `pop`-ed [class, method_name] combination
        while (item = QUEUE.pop) do
          klass, method_name = item
          klass.run(method_name, report)
        end

        # at the end just return the report that we've accumulated
        Ractor.yield report
      end
    end

    # push all tests to the queue
    Microtest::TestCase.subclasses.each do |klass|
      klass.test_methods.each do |method_name|
        QUEUE.push([klass, method_name])
      end
    end
    # push our stop-the-worker flag so that every workers that `pop`s it exits the loop
    CPU_COUNT.times { QUEUE.push(nil) }

    report = Report.new
    # merge reports
    workers.map(&:take).each do |subreport|
      report.merge!(subreport)
    end
    puts
    # and print it
    report.print
  end
end
```

This code is not very different from the one we had to test correctness of queue. One important change here is that `nil` is used as a special flag that stops the worker that pulls it out of the queue. If we need to support passing `nil` through the queue we can introduce another unique object called `EXIT` similar to the `UNDEFINED` that we used to indicate the absence of the value at the moment.

How can we use this code?

```ruby
require_relative './microtest'

def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

def heavy_computation(ms)
  finish_at = now + ms / 1000.0
  counter = 0
  while now < finish_at
    1000.times { counter += 1 }
  end
end

class TestClassOne < Microtest::TestCase
  1.upto(20) do |i|
    class_eval <<~RUBY
      def test_#{i}
        heavy_computation(rand(1000) + 1000)
        assert_eq 1, 1
      end
    RUBY
  end
end

class TestClassTwo < Microtest::TestCase
  def test_that_fails
    heavy_computation(rand(1000) + 1000)
    assert_eq 1, 2
  end
end

Microtest.run!
```

This code defines two classes:

1. `TestClassOne` that has 20 methods, each takes time between 1 and 2 seconds to pass.
2. `TestClassTwo` that has a single method that also runs for up to 2 seconds and then fails

Here’s the output I get:

```
$ time ruby tests/parallel-tests.rb
CPU count: 12
.................F...
Passed: 20
  - TestClassOne#test_2 (in 1.8681494970005588ms)
  - TestClassOne#test_14 (in 1.326054810999267ms)
  - TestClassOne#test_20 (in 1.608019522000177ms)
  - TestClassOne#test_7 (in 1.2940692579995812ms)
  - TestClassOne#test_11 (in 1.1290194040002461ms)
  - TestClassOne#test_15 (in 1.9610371879998638ms)
  - TestClassOne#test_1 (in 1.0031792079998922ms)
  - TestClassOne#test_8 (in 1.6210197430000335ms)
  - TestClassOne#test_17 (in 1.5390436239995324ms)
  - TestClassOne#test_4 (in 1.5251295820007726ms)
  - TestClassOne#test_13 (in 1.5610484249991714ms)
  - TestClassOne#test_19 (in 1.5790689580007893ms)
  - TestClassOne#test_6 (in 1.0661311869998826ms)
  - TestClassOne#test_9 (in 1.5110340849996646ms)
  - TestClassOne#test_16 (in 1.21403959700001ms)
  - TestClassOne#test_5 (in 1.421094257999357ms)
  - TestClassOne#test_12 (in 1.7910449749997497ms)
  - TestClassOne#test_3 (in 1.1941248209996047ms)
  - TestClassOne#test_10 (in 1.7080213600002025ms)
  - TestClassOne#test_18 (in 1.9290160210002796ms)
Failed: 1
  - TestClassTwo#test_that_fails: assertion failed: 1 != 2

real    0m4.978s
user    0m31.265s
sys     0m0.026s
```

So as you can see it took only 5 seconds to run what would take 31 seconds in single-threaded mode and during its execution multiple (but not all) cores have been utilized.

> SPOILER
>
> In the next chapter we'll build a more advanced queue that doesn't acquire the Interpreter Lock and with it I get all cores used at 100%.
>
> If I remove randomness from tests and change each test to take 2 seconds, I get these numbers:
>
> `QueueWithMutex`:
> real  0m6.171s
> user  0m42.128s
> sys   0m0.036s
>
> vs `ToBeDescribedSoonQueue`:
> real  0m4.173s
> user  0m42.020s
> sys   0m0.020s
>
> Which is close to 10x speedup on my 8 cores + 4 threads. There might be a hard parallelism limit that is somehow impacted by GIL but I can't verify it. Note that out Queue is large enough to hold all 20 tests + 12 `nil`s, and so workers don't starve in this case. Also the tests take long enough to have no contention at all and so no looping-and-sleeping happens internally. It **should** utilize all cores, but for some reason it doesn't.
