# Ruby heap

After reading the previous section you might be under the impression that it's easier to think about Ruby heap as if there was a single "shared" heap full of frozen objects and a bunch of per-Ractor heaps that are mutable if you access it from the Ractor that owns it. Yes, maybe it's easier, but in reality, it's still a single heap, and every object is accessible by every Ractor.

```ruby
o = Object.new
Ractor.make_shareable(o)
id = o.object_id
puts "[MAIN] #{id} #{o}"

r = Ractor.new(id) do |id|
  o2 = ObjectSpace._id2ref(id)
  puts "[NON-MAIN] #{id} #{o2}"
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
