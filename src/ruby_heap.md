# Ruby heap

After reading the previous section you might be under the impression that it's easier to think about Ruby heap as if there was a single "shared" heap full of frozen objects and a bunch of per-Ractor heaps that are mutable if you access it from the Ractor that owns it. Yes, maybe it's easier, but in reality, it's still a single heap, and every object is accessible by every Ractor.

```ruby
o = Object.new
Ractor.make_shareable(o)
ID = o.object_id
puts "[MAIN] #{ID} #{o}"

r = Ractor.new do
  o2 = ObjectSpace._id2ref(ID)
  puts "[NON-MAIN] #{ID} #{o2}"
  Ractor.yield :done
end

r.take
```

This code prints

```
[MAIN] 5016 #<Object:0x00007f97f72523a8>
[NON-MAIN] 5016 #<Object:0x00007f97f72523a8>
```

which proves the statement above. However, removing the line `Ractor.make_shareable(o)` breaks the code with an error `"5016" is id of the unshareable object on multi-ractor (RangeError)` (By the way, why is it a `RangeError`?).

How can we make an object shareable (i.e. deeply frozen) but still mutable? Well, we can attach data on the C level to this object and make it mutable.

## Side note: concurrent access is still possible

The snippet above requires calling `Ractor.make_shareable` because we use built-in Ruby methods, but what if we define our own functions?

```c
// Converts given `obj` to its address
VALUE rb_obj_to_address(VALUE self, VALUE obj) { return LONG2NUM(obj); }
// Converts given address back to the object
VALUE rb_address_to_obj(VALUE self, VALUE obj) { return NUM2LONG(obj); }

// and then somewhere in the initialization logic
rb_define_global_function("obj_to_address", rb_obj_to_address, 1);
rb_define_global_function("address_to_obj", rb_address_to_obj, 1);
```

We defined two functions:

```ruby
irb> o = "foo"
=> "foo"
irb> obj_to_address(o)
=> 140180443876200
irb> obj_to_address(o)
=> 140180443876200
irb> address_to_obj(obj_to_address(o))
=> "foo"
```

Let's see if the hack works:

```ruby
require_relative './helper'

o = Object.new
ADDRESS = obj_to_address(o)
puts "[MAIN] #{ADDRESS} #{o}"

r = Ractor.new do
  o2 = address_to_obj(ADDRESS)
  puts "[NON-MAIN] #{ADDRESS} #{o2}"
  Ractor.yield :done
end

r.take
```

prints

```
[MAIN] 140194730661200 #<Object:0x00007f81a11ed550>
[NON-MAIN] 140194730661200 #<Object:0x00007f81a11ed550>
```

Of course doing this without adding any thread-safe wrappers is simply wrong. For example, the following snippet causes segfault:

```ruby
require_relative './helper'

array = []
ADDRESS = obj_to_address(array)

ractors = 2.times.map do\
  # 2 threads
  Ractor.new do
    obj = address_to_obj(ADDRESS)
    # each mutates a shared non-thread-safe array
    1_000_000.times do
      obj.push(42)
      obj.pop
    end
    Ractor.yield :done
  end
end

p ractors.map(&:take)
```
