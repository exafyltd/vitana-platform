-- Migration: seed Shopify mock.shop demo products into marketplace

DO $$
DECLARE
  v_merchant_id UUID;
  v_run_id UUID;
BEGIN

  -- Ingestion run
  INSERT INTO public.catalog_sources (source_network, triggered_by, notes)
  VALUES ('shopify', 'migration_demo_mockshop', 'Demo products from Shopify mock.shop for frontend design')
  RETURNING run_id INTO v_run_id;

  -- Merchant
  INSERT INTO public.merchants (
    name, slug, storefront_url, source_network, source_merchant_id,
    merchant_country, ships_to_regions, currencies,
    affiliate_network, commission_rate, quality_score, customs_risk, is_active
  ) VALUES (
    'Mock.shop Demo Store', 'mockshop-demo', 'https://mock.shop',
    'shopify', 'mock.shop',
    'CA', ARRAY['US','CA','EU','UK'], ARRAY['CAD','USD','EUR'],
    'shopify', 0.0, 70, 'low', TRUE
  ) ON CONFLICT (source_network, source_merchant_id) DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_merchant_id;

  IF v_merchant_id IS NULL THEN
    SELECT id INTO v_merchant_id FROM public.merchants WHERE source_network = 'shopify' AND source_merchant_id = 'mock.shop';
  END IF;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982853619734', 'slides', 'Slides', 'Simple, minimal and comfortable, these slides feature a classic design in the perfect shade of iron. Whether you''re just lounging around the house or running errands, these slides will offer all-day comfort.', 'Mock.shop',
    'lifestyle', ARRAY['accessories','shoes','unisex'], 2500, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/slides.jpg?v=1675447358'], 'https://mock.shop/products/slides',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982856273942', 'sweatpants', 'Sweatpants', 'Soft and comfortable sweatpants in stylish shades. They are perfect for lounging with their cozy stretch fabric that offers just the right amount of warmth. Enjoy the ultimate relaxation experience!', 'Mock.shop',
    'lifestyle', ARRAY['bottoms','men','unisex'], 3500, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenSweatpants01.jpg?v=1675455387','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenSweatpants02.jpg?v=1675455387','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenSweatpants03.jpg?v=1675455387'], 'https://mock.shop/products/sweatpants',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982902771734', 'men-t-shirt', 'Men''s T-shirt', 'Crafted from organic cotton, this classic T-shirt features a relaxed fit, crew neckline and timeless look. Enjoy the breathable comfort of 100% organic cotton.', 'Mock.shop',
    'lifestyle', ARRAY['men','tops'], 4000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenTshirt01.jpg?v=1675455410','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenTshirt02.jpg?v=1675455410','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenTshirt03.jpg?v=1675455410'], 'https://mock.shop/products/men-t-shirt',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982904639510', 'hoodie-old', 'Hoodie', 'This hoodie is the perfect choice for comfort and warmth. Meticulously crafted from 100% cotton, the hoodie features a soft, plush fleece interior and a unisex sizing design. Soft and lightweight, it''s sure to be your go-to for chilly days.', 'Mock.shop',
    'lifestyle', ARRAY['men','tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenHoodie01.jpg?v=1739549220','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenHoodie02.jpg?v=1739549220','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenHoodie03.jpg?v=1739549220'], 'https://mock.shop/products/hoodie-old',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982904705046', 'soft-cotton-hoodie-in-jam', 'Soft Cotton Hoodie in Jam', 'This hoodie is the perfect choice for comfort and warmth. Meticulously crafted from 100% cotton, the hoodie features a soft, plush fleece interior and a unisex sizing design. Soft and lightweight, it''s sure to be your go-to for chilly days.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/RedHoodie01.jpg?v=1739548873','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/RedHoodie02.jpg?v=1739548873','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/RedHoodie03.jpg?v=1739548873'], 'https://mock.shop/products/soft-cotton-hoodie-in-jam',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982904836118', 'soft-cotton-hoodie-in-clay', 'Soft Cotton Hoodie in Clay', 'This hoodie is the perfect choice for comfort and warmth. Meticulously crafted from 100% cotton, the hoodie features a soft, plush fleece interior and a unisex sizing design. Soft and lightweight, it''s sure to be your go-to for chilly days.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayHoodie01.jpg?v=1739548707','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayHoodie02.jpg?v=1739548707','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayHoodie03.jpg?v=1739548707'], 'https://mock.shop/products/soft-cotton-hoodie-in-clay',
    'out_of_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982904868886', 'soft-cotton-hoodie-in-ocean', 'Soft Cotton Hoodie in Ocean', 'This hoodie is the perfect choice for comfort and warmth. Meticulously crafted from 100% cotton, the hoodie features a soft, plush fleece interior and a unisex sizing design. Soft and lightweight, it''s sure to be your go-to for chilly days.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanHoodie01.jpg?v=1739548678','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanHoodie02.jpg?v=1739548678','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanHoodie03.jpg?v=1739548678'], 'https://mock.shop/products/soft-cotton-hoodie-in-ocean',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982904901654', 'soft-cotton-hoodie-in-violet', 'Soft Cotton Hoodie in Violet', 'This hoodie is the perfect choice for comfort and warmth. Meticulously crafted from 100% cotton, the hoodie features a soft, plush fleece interior and a unisex sizing design. Soft and lightweight, it''s sure to be your go-to for chilly days.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/PurpleHoodie01.jpg?v=1739548486','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/PurpleHoodie02.jpg?v=1739548486','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/PurpleHoodie03.jpg?v=1739548486'], 'https://mock.shop/products/soft-cotton-hoodie-in-violet',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982904934422', 'soft-cotton-hoodie-in-green', 'Soft Cotton Hoodie in Green', 'This hoodie is the perfect choice for comfort and warmth. Meticulously crafted from 100% cotton, the hoodie features a soft, plush fleece interior and a unisex sizing design. Soft and lightweight, it''s sure to be your go-to for chilly days.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/1_72ff506b-b5ff-43a0-bc65-9174c99d3d31.png?v=1675117122','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/2_4651ef0e-5f62-4aac-9a05-c3265dc998fd.png?v=1675117123','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/3_4a678089-b183-4274-8fc7-4e36364db980.png?v=1675117122'], 'https://mock.shop/products/soft-cotton-hoodie-in-green',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7982905098262', 'men-crewneck', 'Men''s Crewneck', 'This high-quality crewneck is perfect for your everyday look. Made with 100% cotton, it''s soft, comfortable, and undeniably stylish. Full sleeved for a classic look and effortlessly versatile, this cotton crewneck is a must-have in any wardrobe.', 'Mock.shop',
    'lifestyle', ARRAY['men','tops'], 12000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenMenscrew01.jpg?v=1675454919','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenMenscrew02.jpg?v=1675454919','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenMenscrew03.jpg?v=1675455653'], 'https://mock.shop/products/men-crewneck',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983591030806', 'women-crewneck', 'Women''s Crewneck', 'This high-quality crewneck is perfect for your everyday look. Made with 100% cotton, it''s soft, comfortable, and undeniably stylish. Full sleeved for a classic look and effortlessly versatile, this cotton crewneck is a must-have in any wardrobe.', 'Mock.shop',
    'lifestyle', ARRAY['tops','women'], 12000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenWomenscrew01.jpg?v=1675453375','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenWomenscrew02.jpg?v=1675455045','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenWomenscrew03.jpg?v=1675455045'], 'https://mock.shop/products/women-crewneck',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983592374294', 'women-t-shirt', 'Women''s T-shirt', 'Crafted from organic cotton, this classic T-shirt features a relaxed fit, crew neckline and timeless look. Enjoy the breathable comfort of 100% organic cotton.', 'Mock.shop',
    'lifestyle', ARRAY['tops','women'], 4000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenWomensTshirt01.jpg?v=1675463247','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayWomensTshirt01.jpg?v=1675463247','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanWomensTshirt01.jpg?v=1675463247'], 'https://mock.shop/products/women-t-shirt',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983593095190', 'canvas-sneakers', 'Canvas Sneakers', 'These high-quality canvas sneakers offer a comfortable fit and superior breathability, thanks to their cushioning midsoles and durable construction. An array of stylish colors adds to the appeal, making them perfect for casual wear. Slip them on and enjoy reliable performance and style that lasts.', 'Mock.shop',
    'lifestyle', ARRAY['accessories','men','shoes'], 4000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenCanvasSneaker01.jpg?v=1675454881','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayCanvasSneaker01.jpg?v=1675454881','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanCanvasSneaker01.jpg?v=1675446185'], 'https://mock.shop/products/canvas-sneakers',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983593357334', 'frontpack', 'Frontpack', 'This frontpack is the perfect combination of form and function, with a modern, sporty design and patented technology that enables you to easily carry numerous items on the go. It''s light, comfortable and has adjustable straps to fit all body types. Plus, its water-resistant outer shell ensures your items stay dry and secure.', 'Mock.shop',
    'lifestyle', ARRAY['accessories','unisex'], 20000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenFrontpack.jpg?v=1675455064','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayFrontpack.jpg?v=1675455064','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanFrontpack.jpg?v=1675446346'], 'https://mock.shop/products/frontpack',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983593390102', 'half-zip', 'Half Zip', 'This half zip athletic sweatshirt is designed for optimum comfort and convenience. The half zip provides easy access to slip on and off, and the lightweight fabric is breathable and flexible, ideal for active pursuits. Perfect for athletes of all levels.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 10000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenHalfzip01.jpg?v=1675455104','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayHalfzip01.jpg?v=1675455104','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanHalfzip01.jpg?v=1675446496'], 'https://mock.shop/products/half-zip',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983593422870', 'leggings', 'Leggings', 'These sporty and lightweight leggings are designed for comfort and ease of movement. Its moisture-wicking fabric and strong seams keep you feeling cool and secure. Available in an array of colors, these leggings are an ideal choice to look stylish while exercising.', 'Mock.shop',
    'lifestyle', ARRAY['bottoms','women'], 2000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenLeggings03.jpg?v=1675455256','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenLeggings02.jpg?v=1675455256','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayLeggings03.jpg?v=1675455256'], 'https://mock.shop/products/leggings',
    'out_of_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983593947158', 'light-puffer', 'Light Puffer', 'This light puffer vest is made from durable nylon and will keep you dry and comfortable in all weather. Its light coating provides reliable protection from wind and rain, and its versatile fit offers maximum mobility. Perfect for moderate temperatures and varied conditions.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 8000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/green.jpg?v=1675459832','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/claynew.jpg?v=1675459832','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ocean.jpg?v=1675459832'], 'https://mock.shop/products/light-puffer',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983594176534', 'puffer', 'Puffer', 'This light puffer vest is made from durable nylon and will keep you dry and comfortable in all weather. Its light coating provides reliable protection from wind and rain, and its versatile fit offers maximum mobility. Perfect for moderate temperatures and varied conditions.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 8000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenPuffer01.jpg?v=1675455329','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayPuffer01.jpg?v=1675455329','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanPuffer01.jpg?v=1675446873'], 'https://mock.shop/products/puffer',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983594340374', 'puffer-jacket', 'Puffer Jacket', 'This light puffer jacket is made from durable nylon and will keep you dry and comfortable in all weather. Its light coating provides reliable protection from wind and rain, and its versatile fit offers maximum mobility. Perfect for moderate temperatures and varied conditions.', 'Mock.shop',
    'lifestyle', ARRAY['tops','unisex'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenPufferjacket01.jpg?v=1675455364','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayPufferjacket01.jpg?v=1675455364','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanPufferjacket01.jpg?v=1675446974'], 'https://mock.shop/products/puffer-jacket',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983594471446', 'shorts', 'Shorts', 'These shorts are designed to help you reach peak performance. Constructed with high performance nylon fabric in a variety of shades, they are built to last and provide maximum comfort.', 'Mock.shop',
    'lifestyle', ARRAY['bottoms','men'], 4500, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenShorts.jpg?v=1675462426','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayShorts.jpg?v=1675462426','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanShorts.jpg?v=1675462426'], 'https://mock.shop/products/shorts',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983594962966', 'workout-shirt', 'Workout Shirt', 'This high-performance workout shirt made from high-quality Nylon is designed with comfort and durability in mind. Its breathable mesh construction keeps your body temperature regulated while you exercise, while the antistatic and antibacterial finish ensures it will remain light and soft to the touch, wash after wash. With its lightweight design and adjustable straps, it''s sure to stay in place during even the toughest workouts.', 'Mock.shop',
    'lifestyle', ARRAY['tops','women'], 1000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/GreenWorkoutShirt.jpg?v=1675455464','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/ClayWorkoutShirt.jpg?v=1675455464','https://cdn.shopify.com/s/files/1/0688/1755/1382/products/OceanWorkoutShirt.jpg?v=1675447182'], 'https://mock.shop/products/workout-shirt',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983595290646', 'black-sunnies', 'Black Sunnies', 'These modern black sunglasses provide 100% UV400 protection from harmful sunrays and feature mirrored lenses for a timeless and stylish look. With lightweight construction and comfortable fit, you can look cool and stay safe in any situation.', 'Mock.shop',
    'lifestyle', ARRAY['accessories','unisex'], 5000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/Blacksunnies.jpg?v=1675447388'], 'https://mock.shop/products/black-sunnies',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983595323414', 'white-leather-sneakers', 'White Leather Sneakers', '', 'Mock.shop',
    'lifestyle', ARRAY['accessories','men','shoes'], 9000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/Differentwhiteleathersneakers01.jpg?v=1675447428'], 'https://mock.shop/products/white-leather-sneakers',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983595356182', 'gray-leather-sneakers', 'Gray Leather Sneakers', 'These gray leather sneakers combine comfort and style for the perfect professional look. The breathable leather material ensures breathability and provides a comfortable fit, perfect for the office and other formal occasions. The handmade design is stylish and guaranteed to last.', 'Mock.shop',
    'lifestyle', ARRAY['accessories','men','shoes'], 100000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/Greyleathersneakers.jpg?v=1675447462'], 'https://mock.shop/products/gray-leather-sneakers',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, sku, title, description, brand,
    category, topic_keys, price_cents, currency, images, affiliate_url,
    availability, origin_country, ships_to_regions
  ) VALUES (
    v_merchant_id, 'shopify', 'gid://shopify/Product/7983595388950', 'gray-runners', 'Gray Runners', 'These gray runners are the perfect choice for running enthusiasts. These shoes provide superior breathability and comfort, so you can run longer with less fatigue. The lightweight design and airy mesh material make these shoes durable and lightweight, giving you the support you need for peak performance.', 'Mock.shop',
    'lifestyle', ARRAY['accessories','men','shoes'], 3000, 'CAD', ARRAY['https://cdn.shopify.com/s/files/1/0688/1755/1382/products/Greyrunners.jpg?v=1675447483'], 'https://mock.shop/products/gray-runners',
    'in_stock', 'CA', ARRAY['US','CA','EU','UK']
  ) ON CONFLICT (source_network, source_product_id) DO UPDATE SET last_seen_at = NOW(), is_active = TRUE;

  -- Close run
  UPDATE public.catalog_sources SET finished_at = NOW(), products_inserted = 25 WHERE run_id = v_run_id;

END $$;

NOTIFY pgrst, 'reload schema';
