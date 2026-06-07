from PIL import Image

for i in range(3):
    try:
        img_std = Image.open(f'/home/ankit-poudel/magazine/frontend/public/test-extract/img-00{i}-std.png')
        img_inv = Image.open(f'/home/ankit-poudel/magazine/frontend/public/test-extract/img-00{i}-inv.png')
        print(f'Image {i} (std) size {img_std.size} corner pixel (10,10):', img_std.getpixel((10,10)))
        print(f'Image {i} (inv) size {img_inv.size} corner pixel (10,10):', img_inv.getpixel((10,10)))
        
        # Calculate standard deviation or average of a small area
        std_pixels = [img_std.getpixel((x, y)) for y in range(10, 30) for x in range(10, 30)]
        inv_pixels = [img_inv.getpixel((x, y)) for y in range(10, 30) for x in range(10, 30)]
        
        avg_std = [sum(x)/len(std_pixels) for x in zip(*std_pixels)]
        avg_inv = [sum(x)/len(inv_pixels) for x in zip(*inv_pixels)]
        
        print(f'Image {i} (std) avg of corner block:', avg_std)
        print(f'Image {i} (inv) avg of corner block:', avg_inv)
    except Exception as e:
         print(f'Error reading {i}:', e)
